import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readQueue, dropFromQueue } from "../lib/priority.js";
import { selectBatch } from "../lib/schedule.js";

let dir;
let file;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-priority-"));
	file = path.join(dir, "priority.txt");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the priority queue file", () => {
	test("reads one URL per line, ignoring blanks and comments", () => {
		fs.writeFileSync(file, "# why\nhttps://a.example/\n\n  https://b.example/  \n");
		assert.deepEqual(readQueue(file), ["https://a.example/", "https://b.example/"]);
	});

	test("normalizes and deduplicates", () => {
		fs.writeFileSync(file, "https://a.example/deep/\nhttps://a.example/deep\n");
		assert.deepEqual(readQueue(file), ["https://a.example/deep"]);
	});

	test("a missing file is an empty queue, not an error", () => {
		assert.deepEqual(readQueue(path.join(dir, "nope.txt")), []);
	});

	test("removing an entry leaves comments and the other lines alone", () => {
		fs.writeFileSync(file, "# keep me\nhttps://a.example/\nhttps://b.example/\n");
		assert.equal(dropFromQueue(file, ["https://a.example/"]), 1);

		const after = fs.readFileSync(file, "utf8");
		assert.match(after, /# keep me/);
		assert.doesNotMatch(after, /a\.example/);
		assert.match(after, /b\.example/);
	});

	test("matches the same normalized form readQueue does", () => {
		fs.writeFileSync(file, "https://a.example/deep/\n");
		// Queued with a trailing slash, removed without one.
		assert.equal(dropFromQueue(file, ["https://a.example/deep"]), 1);
		assert.deepEqual(readQueue(file), []);
	});

	test("writes nothing when there is nothing to remove", () => {
		fs.writeFileSync(file, "https://a.example/\n");
		const before = fs.statSync(file).mtimeMs;
		assert.equal(dropFromQueue(file, []), 0);
		assert.equal(dropFromQueue(file, ["https://other.example/"]), 0);
		assert.equal(fs.statSync(file).mtimeMs, before);
	});
});

describe("queued URLs in a batch", () => {
	const now = Date.parse("2026-08-22T12:00:00Z");
	const HOUR = 3600e3;

	function fixture(ages) {
		const sites = Object.keys(ages).map((url, i) => ({
			url,
			hash: String(i).repeat(8),
			freshnessHours: 24,
		}));
		const store = {
			lastMeasuredAt: (url) => (ages[url] === null ? null : now - ages[url] * HOUR),
			latest: () => null,
		};
		return { sites, store };
	}

	test("jumps the queue ahead of staler sites", () => {
		const { sites, store } = fixture({
			"https://queued.example/": 1,
			"https://ancient.example/": 500,
		});
		const batch = selectBatch(sites, store, { now, freshnessHours: 24, priority: ["https://queued.example/"] });

		assert.equal(batch.selected[0].url, "https://queued.example/");
		assert.deepEqual(batch.priority, ["https://queued.example/"]);
	});

	test("ignores the freshness window", () => {
		const { sites, store } = fixture({ "https://queued.example/": 0.1 });
		const batch = selectBatch(sites, store, { now, freshnessHours: 24, priority: ["https://queued.example/"] });

		assert.equal(batch.selected.length, 1);
		assert.equal(batch.skipped.fresh, 0);
	});

	test("does not revive an archived URL", () => {
		const { sites, store } = fixture({ "https://gone.example/": 900 });
		sites[0].archived = true;
		const batch = selectBatch(sites, store, { now, priority: ["https://gone.example/"] });

		assert.equal(batch.selected.length, 0);
		assert.equal(batch.skipped.archived, 1);
		assert.deepEqual(batch.priority, []);
	});

	test("reports only the queued URLs the batch actually took", () => {
		const { sites, store } = fixture({
			"https://one.example/": 1,
			"https://two.example/": 1,
		});
		const batch = selectBatch(sites, store, {
			now,
			limit: 1,
			freshnessHours: 24,
			priority: ["https://one.example/", "https://two.example/"],
		});

		// The one left behind is still queued, so it must not be reported as done.
		assert.equal(batch.priority.length, 1);
		assert.equal(batch.selected.length, 1);
	});
});
