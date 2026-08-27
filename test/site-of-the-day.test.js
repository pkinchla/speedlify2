import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { selectSiteOfTheDay } from "../lib/site-of-the-day.js";

/**
 * The rule the card promises: every eligible perfect site is featured once
 * before any is featured twice.
 *
 * Nothing is stored, so the property under test is purity — the same day and
 * pool must always produce the same answer, on any checkout, at any time.
 */

const pool = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://site${i}.example/` }));
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

const run = (entries, days, from = 0) =>
	Array.from({ length: days }, (_, i) => selectSiteOfTheDay(entries, day(from + i)).entry.url);

describe("perfect site of the day", () => {
	test("features every site once before repeating any", () => {
		const entries = pool(12);
		const picked = run(entries, 12);

		assert.equal(new Set(picked).size, 12, "no repeats within a cycle");
		assert.deepEqual([...picked].sort(), entries.map((e) => e.url).sort(), "every site had a turn");
	});

	test("starts a fresh cycle once every site has been featured", () => {
		const entries = pool(5);
		const first = run(entries, 5, 0);
		const second = run(entries, 5, 5);

		assert.equal(new Set(first).size, 5);
		assert.equal(new Set(second).size, 5, "the second cycle covers the pool again");
		assert.equal(selectSiteOfTheDay(entries, day(4)).cycle, 1);
		assert.equal(selectSiteOfTheDay(entries, day(5)).cycle, 2, "cycle turns over on schedule");
	});

	test("is pure — the hourly rebuild recomputes the same answer", () => {
		const entries = pool(30);
		for (const d of [0, 7, 29, 30, 101]) {
			const a = selectSiteOfTheDay(entries, day(d));
			const b = selectSiteOfTheDay(entries, day(d));
			assert.equal(a.entry.url, b.entry.url, `day ${d} is stable`);
		}
	});

	test("reports its position in the cycle", () => {
		const entries = pool(4);
		assert.deepEqual(
			[0, 1, 2, 3, 4].map((d) => selectSiteOfTheDay(entries, day(d)).position),
			[1, 2, 3, 4, 1],
		);
		assert.equal(selectSiteOfTheDay(entries, day(0)).pool, 4);
	});

	test("a one-site pool features it every day rather than failing", () => {
		const entries = pool(1);
		assert.equal(selectSiteOfTheDay(entries, day(0)).entry.url, entries[0].url);
		assert.equal(selectSiteOfTheDay(entries, day(9)).entry.url, entries[0].url);
	});

	test("an empty pool yields nothing rather than throwing", () => {
		assert.equal(selectSiteOfTheDay([], day(0)), null);
	});

	test("dates before the epoch still land inside a cycle", () => {
		// floorDiv, not truncation: a negative day index must round down or the
		// position within the cycle comes out negative and the replay is skipped.
		const entries = pool(7);
		const before = new Date(Date.UTC(2025, 10, 3)).toISOString().slice(0, 10);
		const r = selectSiteOfTheDay(entries, before);
		assert.ok(r.position >= 1 && r.position <= 7, `position ${r.position} in range`);
	});

	test("the replay cost is bounded by the pool, not by elapsed time", () => {
		// A far-future date must not be slower than an early one: cycle
		// boundaries are fixed multiples of the pool size, so the replay never
		// covers more than one cycle.
		const entries = pool(200);
		const t0 = process.hrtime.bigint();
		selectSiteOfTheDay(entries, day(5));
		const early = process.hrtime.bigint() - t0;

		const t1 = process.hrtime.bigint();
		selectSiteOfTheDay(entries, day(50_000));
		const late = process.hrtime.bigint() - t1;

		assert.ok(Number(late) < Number(early) * 50 + 50_000_000, "no unbounded replay");
	});
});
