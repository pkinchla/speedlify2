import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectBatch, partition, parseShard, backoffHours, nextFailureCount } from "../lib/schedule.js";

const HOUR = 3600000;
const NOW = Date.UTC(2026, 0, 10, 12);

/** Minimal ResultStore stand-in: { url: { agoHours, error, consecutiveFailures } }. */
function fakeStore(state) {
	return {
		lastMeasuredAt(url) {
			const s = state[url];
			return s && s.agoHours !== undefined ? NOW - s.agoHours * HOUR : null;
		},
		latest(url) {
			const s = state[url];
			if (!s || s.agoHours === undefined) return null;
			return { error: s.error || null, consecutiveFailures: s.consecutiveFailures || 0 };
		},
	};
}

const sites = (...names) => names.map((n) => ({ name: n, url: `https://${n}.example/`, hash: hashOf(n) }));

// Deterministic stand-in for the real url hash.
function hashOf(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(12, "0");
}

describe("selectBatch", () => {
	test("prioritises never-measured sites above everything else", () => {
		const list = sites("a", "b", "c");
		const store = fakeStore({
			"https://a.example/": { agoHours: 100 },
			"https://b.example/": { agoHours: 200 },
			// c has never been measured
		});

		const batch = selectBatch(list, store, { limit: 1, now: NOW });
		assert.equal(batch.selected[0].name, "c");
	});

	test("orders by staleness, oldest first", () => {
		const list = sites("a", "b", "c");
		const store = fakeStore({
			"https://a.example/": { agoHours: 5 },
			"https://b.example/": { agoHours: 50 },
			"https://c.example/": { agoHours: 20 },
		});

		const batch = selectBatch(list, store, { now: NOW });
		assert.deepEqual(batch.selected.map((s) => s.name), ["b", "c", "a"]);
	});

	test("respects the limit and reports what is left", () => {
		const list = sites("a", "b", "c", "d");
		const store = fakeStore({});

		const batch = selectBatch(list, store, { limit: 2, now: NOW });
		assert.equal(batch.selected.length, 2);
		assert.equal(batch.eligible, 4);
		assert.equal(batch.caughtUp, false);
	});

	test("reports caught up when everything eligible fits", () => {
		const batch = selectBatch(sites("a", "b"), fakeStore({}), { limit: 10, now: NOW });
		assert.equal(batch.caughtUp, true);
	});

	test("skips sites measured within the freshness window", () => {
		const list = sites("a", "b");
		const store = fakeStore({
			"https://a.example/": { agoHours: 1 },
			"https://b.example/": { agoHours: 30 },
		});

		const batch = selectBatch(list, store, { freshnessHours: 20, now: NOW });
		assert.deepEqual(batch.selected.map((s) => s.name), ["b"]);
		assert.equal(batch.skipped.fresh, 1);
	});

	test("retries a failing site on the very next run", () => {
		// An error is not data, so it must not buy the site a freshness window.
		// On a weekly cadence that would leave a transient blip unretried for a
		// week — which is the whole reason backoff is off by default.
		const list = sites("broken", "healthy");
		const store = fakeStore({
			"https://broken.example/": { agoHours: 0.1, error: "timeout", consecutiveFailures: 9 },
			"https://healthy.example/": { agoHours: 1 },
		});

		const batch = selectBatch(list, store, { freshnessHours: 168, now: NOW });
		assert.deepEqual(batch.selected.map((s) => s.name), ["broken"]);
		assert.equal(batch.skipped.fresh, 1, "the healthy site is still held by freshness");
		assert.equal(batch.skipped.backoff, 0);
	});

	test("a failing site ignores a per-category freshness window too", () => {
		const list = [{ name: "broken", url: "https://broken.example/", freshnessHours: 500 }];
		const store = fakeStore({
			"https://broken.example/": { agoHours: 0.1, error: "timeout", consecutiveFailures: 2 },
		});

		const batch = selectBatch(list, store, { freshnessHours: 168, now: NOW });
		assert.equal(batch.selected.length, 1);
	});

	test("backs off a repeatedly failing site when asked to", () => {
		const list = sites("broken", "healthy");
		const store = fakeStore({
			// 4 consecutive failures -> 8h backoff, last attempt 2h ago
			"https://broken.example/": { agoHours: 2, error: "timeout", consecutiveFailures: 4 },
			"https://healthy.example/": { agoHours: 3 },
		});

		const batch = selectBatch(list, store, { now: NOW, failureBackoff: true });
		assert.deepEqual(batch.selected.map((s) => s.name), ["healthy"]);
		assert.equal(batch.skipped.backoff, 1);
	});

	test("retries a failing site once its backoff has elapsed", () => {
		const list = sites("broken");
		const store = fakeStore({
			// 8h backoff, last attempt 10h ago
			"https://broken.example/": { agoHours: 10, error: "timeout", consecutiveFailures: 4 },
		});

		const batch = selectBatch(list, store, { now: NOW, failureBackoff: true });
		assert.equal(batch.selected.length, 1);
	});

	test("a run with no eligible sites is a valid outcome, not an error", () => {
		const store = fakeStore({
			"https://a.example/": { agoHours: 1 },
			"https://b.example/": { agoHours: 2 },
		});

		const batch = selectBatch(sites("a", "b"), store, { freshnessHours: 20, now: NOW });
		assert.equal(batch.selected.length, 0);
		assert.equal(batch.caughtUp, true);
	});

	test("selection is stable across repeated calls", () => {
		const list = sites("a", "b", "c", "d", "e");
		const store = fakeStore({});

		const first = selectBatch(list, store, { limit: 2, now: NOW }).selected.map((s) => s.name);
		const second = selectBatch(list, store, { limit: 2, now: NOW }).selected.map((s) => s.name);
		assert.deepEqual(first, second);
	});

	test("confines selection to the requested shard", () => {
		const list = sites("a", "b", "c", "d", "e", "f");
		const shard = { index: 0, total: 2 };
		const expected = partition(list, shard).map((s) => s.name);

		const batch = selectBatch(list, fakeStore({}), { now: NOW, shard });
		assert.deepEqual(batch.selected.map((s) => s.name).sort(), expected.sort());
		assert.equal(batch.poolSize, expected.length);
	});
});

describe("partition", () => {
	test("shards are disjoint and cover every site", () => {
		const list = sites(...Array.from({ length: 50 }, (_, i) => `site${i}`));
		const seen = new Set();

		for (let i = 0; i < 4; i++) {
			for (let s of partition(list, { index: i, total: 4 })) {
				assert.ok(!seen.has(s.hash), `${s.name} appeared in more than one shard`);
				seen.add(s.hash);
			}
		}
		assert.equal(seen.size, list.length);
	});

	test("assignment is stable when the config list is reordered", () => {
		const list = sites("a", "b", "c", "d", "e");
		const before = partition(list, { index: 1, total: 3 }).map((s) => s.name).sort();
		const after = partition([...list].reverse(), { index: 1, total: 3 }).map((s) => s.name).sort();
		assert.deepEqual(before, after);
	});

	test("rejects an out-of-range shard", () => {
		assert.throws(() => partition(sites("a"), { index: 4, total: 4 }), /between 0 and 3/);
		assert.throws(() => partition(sites("a"), { index: 0, total: 0 }), /positive integer/);
	});
});

describe("parseShard", () => {
	test("converts 1-based input to a 0-based index", () => {
		assert.deepEqual(parseShard("1/4"), { index: 0, total: 4 });
		assert.deepEqual(parseShard("4/4"), { index: 3, total: 4 });
	});

	test("returns null when unset", () => {
		assert.equal(parseShard(undefined), null);
		assert.equal(parseShard(""), null);
	});

	test("rejects malformed and out-of-range input", () => {
		assert.throws(() => parseShard("abc"), /1\/4/);
		assert.throws(() => parseShard("0/4"), /between 1 and 4/);
		assert.throws(() => parseShard("5/4"), /between 1 and 4/);
	});
});

describe("backoffHours", () => {
	test("grows exponentially then caps at a day", () => {
		assert.equal(backoffHours(0), 0);
		assert.equal(backoffHours(1), 1);
		assert.equal(backoffHours(3), 4);
		assert.equal(backoffHours(6), 24);
		assert.equal(backoffHours(50), 24, "a long-dead site is still retried daily");
	});
});

describe("nextFailureCount", () => {
	test("increments on failure and resets on success", () => {
		assert.equal(nextFailureCount({ consecutiveFailures: 2 }, true), 3);
		assert.equal(nextFailureCount({ consecutiveFailures: 5 }, false), 0);
		assert.equal(nextFailureCount(null, true), 1);
		assert.equal(nextFailureCount(null, false), 0);
	});
});

describe("retryErrorsAfterHours", () => {
	const failing = (agoHours, consecutiveFailures = 1) => ({
		"https://broken.example/": { agoHours, error: "timeout", consecutiveFailures },
	});

	test("0 retries on the very next run", () => {
		const batch = selectBatch(sites("broken"), fakeStore(failing(0.1)), {
			freshnessHours: 168,
			retryErrorsAfterHours: 0,
			now: NOW,
		});
		assert.equal(batch.selected.length, 1);
	});

	test("holds a failure until the configured interval has passed", () => {
		const store = fakeStore(failing(2));
		const held = selectBatch(sites("broken"), store, { retryErrorsAfterHours: 6, now: NOW });
		assert.equal(held.selected.length, 0);
		assert.equal(held.skipped.backoff, 1);

		const due = selectBatch(sites("broken"), fakeStore(failing(7)), {
			retryErrorsAfterHours: 6,
			now: NOW,
		});
		assert.equal(due.selected.length, 1);
	});

	test("a category can set its own retry interval", () => {
		const list = [{ name: "broken", url: "https://broken.example/", retryErrorsAfterHours: 12 }];
		const batch = selectBatch(list, fakeStore(failing(5)), { retryErrorsAfterHours: 1, now: NOW });
		assert.equal(batch.selected.length, 0, "the site's own interval wins over the default");
	});

	test("composes with the backoff curve, taking whichever waits longer", () => {
		// 5 consecutive failures -> 16h curve. A 2h floor must not shorten it.
		const short = selectBatch(sites("broken"), fakeStore(failing(10, 5)), {
			retryErrorsAfterHours: 2,
			failureBackoff: true,
			now: NOW,
		});
		assert.equal(short.selected.length, 0, "the curve still applies");

		// One failure -> 1h curve. A 24h floor must not shorten that either.
		const long = selectBatch(sites("broken"), fakeStore(failing(10, 1)), {
			retryErrorsAfterHours: 24,
			failureBackoff: true,
			now: NOW,
		});
		assert.equal(long.selected.length, 0, "the floor still applies");
	});

	test("a healthy site is unaffected by it", () => {
		const store = fakeStore({ "https://a.example/": { agoHours: 30 } });
		const batch = selectBatch(sites("a"), store, {
			freshnessHours: 20,
			retryErrorsAfterHours: 999,
			now: NOW,
		});
		assert.equal(batch.selected.length, 1);
	});
});
