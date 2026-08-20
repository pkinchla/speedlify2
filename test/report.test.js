import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReport, REPORT_VERSION } from "../lib/report.js";
import { ResultStore } from "../lib/store.js";

/**
 * The report is the contract between measurement and rendering: if a field the
 * templates read stops being emitted, the site renders blanks rather than
 * failing. These tests pin the shape.
 */

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function fixture({ sites = 1, points = 4, url = (i) => `https://site${i}.example/` } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-report-"));
	tmp.push(dir);

	const store = new ResultStore(path.join(dir, "results"));

	for (let s = 0; s < sites; s++) {
		for (let p = 0; p < points; p++) {
			store.write({
				url: url(s),
				name: `Site ${s}`,
				group: "g",
				timestamp: Date.UTC(2026, 0, p + 1),
				date: new Date(Date.UTC(2026, 0, p + 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 30000,
				error: null,
				variance: { spread: 1 },
				lab: {
					requestedUrl: url(s),
					finalUrl: url(s),
					redirect: null,
					scores: { performance: 80 + p, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 2000 - p * 50, cls: 0.01, tbt: 30, fcp: 1000, si: 1200, ttfb: 200 },
					weight: { total: 500000, requests: 40, byType: { script: { bytes: 1000, requests: 2 } } },
					thirdParty: { count: 0, bytes: 0, mainThreadMs: 0, top: [] },
					waste: { unusedJsBytes: 0, unusedCssBytes: 0 },
					mainThread: { total: 900, longTasks: 1, byGroup: { scriptEvaluation: 500 } },
					dom: { elements: 1000, depth: 10, maxChildren: 5 },
					accessibility: { failingCount: 0, applicableCount: 30, failingNodes: 0, failing: [] },
					hygiene: { https: 1, protocol: "h2", consoleErrors: 0 },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
					lcpBreakdown: { timeToFirstByte: 100 },
				},
				field: null,
			});
		}
	}

	const configFile = path.join(dir, "sites.js");
	const entries = Array.from({ length: sites }, (_, s) => `{ name: "Site ${s}", url: "${url(s)}" }`).join(",");
	fs.writeFileSync(
		configFile,
		`export default { runs: 3, formFactor: "mobile", groups: { g: { name: "Group", sites: [${entries}] } } };`
	);

	return { dir, resultsDir: path.join(dir, "results"), configFile };
}

describe("buildReport", () => {
	test("emits the top-level shape the templates read", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		for (let key of [
			"version", "config", "metrics", "entries", "groups", "orphans",
			"moving", "moved", "stats", "coverage", "generated",
			"hasFieldData", "cruxEnabled", "cwvAvailable",
		]) {
			assert.ok(key in r, `report is missing "${key}"`);
		}
		assert.equal(r.version, REPORT_VERSION);
	});

	test("is JSON round-trippable without loss", async () => {
		const f = fixture({ sites: 2 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		const round = JSON.parse(JSON.stringify(r));
		assert.equal(round.entries.length, r.entries.length);
		assert.deepEqual(round.entries[0].trends.performance.values, r.entries[0].trends.performance.values);
	});

	test("entries carry the fields the site page renders", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const e = r.entries[0];

		for (let key of [
			"url", "name", "hash", "group", "groupName", "history", "historyCount",
			"totalCount", "latest", "currentlyFailing", "trends", "ranks",
			"groupRanks", "stale", "neverMeasured", "previousUrls", "redirectTo",
		]) {
			assert.ok(key in e, `entry is missing "${key}"`);
		}

		// The detail panels come from the one full record.
		assert.ok(e.latest.lab.weight.byType, "latest must keep nested detail");
		assert.ok(e.latest.lab.hygiene);
	});

	test("trends keep values but not the duplicated point objects", async () => {
		const f = fixture({ points: 5 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const t = r.entries[0].trends.lcp;

		assert.deepEqual(t.values, [2000, 1950, 1900, 1850, 1800]);
		assert.ok(!("points" in t), "full point objects must not be serialized 26x per site");
		assert.ok(!("path" in t), "internal lookup path is not needed by consumers");
		assert.ok(!("note" in t), "per-metric prose is emitted once under report.metrics");

		// Fields the templates do read.
		assert.equal(t.current, 1800);
		assert.equal(t.lowerIsBetter, true);
		assert.equal(typeof t.significant, "boolean");
		assert.ok(t.vsPrevious);
	});

	test("history is capped to the log rows the table renders", async () => {
		const f = fixture({ points: 50 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const e = r.entries[0];

		assert.equal(e.history.length, 30, "emitted history is bounded");
		assert.equal(e.historyCount, 50, "but the trend window is reported honestly");
		assert.equal(e.totalCount, 50);
		// Trends were computed over the whole window, not the emitted slice.
		assert.equal(e.trends.performance.values.length, 50);
	});

	test("carries the metric definitions so the report renders standalone", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.ok(Array.isArray(r.metrics.LAB_METRICS));
		const lcp = r.metrics.LAB_METRICS.find((m) => m.key === "lcp");
		assert.equal(lcp.unit, "ms");
		assert.ok(lcp.label);
	});

	test("ranks globally and within the group separately", async () => {
		const f = fixture({ sites: 3 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		for (let e of r.entries) {
			assert.ok(e.ranks.performance >= 1);
			// Group ranks are keyed by group id, so a site in several categories
			// carries a separate rank in each.
			assert.ok(e.groupRanks.g.performance >= 1);
		}
	});

	test("omits Core Web Vitals when CrUX is not configured", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, cruxEnabled: false });

		assert.equal(r.cwvAvailable, false);
		assert.equal(r.entries[0].cwv, null);
	});

	test("offers the lab approximation when CrUX is configured", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, cruxEnabled: true });

		assert.equal(r.entries[0].cwv.source, "lab");
	});

	test("reports coverage over an empty results directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-empty-"));
		tmp.push(dir);
		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: { g: { name: "G", sites: [{ name: "A", url: "https://a.example/" }] } } };`
		);

		const r = await buildReport({ resultsDir: path.join(dir, "results"), configFile });

		assert.equal(r.entries.length, 1);
		assert.equal(r.entries[0].latest, null);
		assert.equal(r.entries[0].neverMeasured, true);
		assert.equal(r.coverage.never, 1);
		assert.equal(r.stats.measured, 0);
	});

	test("is deterministic for the same inputs", async () => {
		const f = fixture({ sites: 2 });
		const now = Date.UTC(2026, 5, 1);

		const a = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now });
		const b = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now });

		// `generated` is a wall-clock stamp; everything else must match.
		delete a.generated;
		delete b.generated;
		assert.deepEqual(a, b);
	});
});

describe("generator-driven reclassification", () => {
	/**
	 * A curated list records what was submitted, which drifts from what is true.
	 * `requireGenerator` moves the drifted entries into an emeritus category at
	 * report time, from what measurement actually found.
	 */
	function generatorFixture(generators) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-emeritus-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));

		generators.forEach((generator, i) => {
			store.write({
				url: `https://site${i}.example/`,
				name: `Site ${i}`,
				group: "curated",
				timestamp: Date.UTC(2026, 0, 1),
				date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 1000,
				error: null,
				lab: {
					requestedUrl: `https://site${i}.example/`,
					finalUrl: `https://site${i}.example/`,
					scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
					weight: { total: 1000, requests: 1, byType: {} },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
				},
				// `raw` is what the report re-derives detection from.
				axe: generator ? { generator: { raw: generator }, headers: {} } : null,
				field: null,
			});
		});

		const entries = generators.map((_, i) => `{ url: "https://site${i}.example/" }`).join(",");
		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				curated: { name: "Curated", requireGenerator: ["eleventy", "build-awesome"], emeritusGroup: "past", sites: [${entries}] },
				past: { name: "Emeritus", sites: [] },
			} };`,
		);

		return { resultsDir: path.join(dir, "results"), configFile };
	}

	const groupOf = (report, id) => report.groups.find((g) => g.id === id);

	test("moves a site measured as a different generator", async () => {
		const f = generatorFixture(["Astro v5.0.0"]);
		const r = await buildReport(f);

		assert.equal(groupOf(r, "curated").entries.length, 0);
		assert.equal(groupOf(r, "past").entries.length, 1);
		assert.equal(r.emeritus.length, 1);
		assert.equal(r.emeritus[0].generator, "Astro");
		assert.equal(r.emeritus[0].to, "past");
	});

	test("keeps a site with no generator detected", async () => {
		// The normal case for a static site. Absence is not evidence.
		const r = await buildReport(generatorFixture([null]));
		assert.equal(groupOf(r, "curated").entries.length, 1);
		assert.equal(r.emeritus.length, 0);
	});

	test("keeps every accepted generator, including the rename", async () => {
		// Build Awesome reports under its own id, so it qualifies only because
		// the category lists it — the transitional and bare tags both count.
		const r = await buildReport(
			generatorFixture(["Eleventy v3.1.6", "Build Awesome v4.0.0", "Eleventy (Build Awesome) v4.0.0", "11ty"]),
		);
		assert.equal(groupOf(r, "curated").entries.length, 4);
		assert.equal(r.emeritus.length, 0);
	});

	test("a rename the category does not list is still moved out", async () => {
		// Guards the mechanism itself: qualifying is by explicit id, not by
		// sharing a brand mark with the required generator.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-emeritus-strict-"));
		tmp.push(dir);
		const f = generatorFixture(["Build Awesome v4.0.0"]);
		const config = fs.readFileSync(f.configFile, "utf8").replace('"eleventy", "build-awesome"', '"eleventy"');
		fs.writeFileSync(f.configFile, config);

		const r = await buildReport(f);
		assert.equal(groupOf(r, "past").entries.length, 1);
		assert.equal(r.emeritus[0].generator, "Build Awesome");
	});

	test("updates the entry's own group fields, not just the group listing", async () => {
		const r = await buildReport(generatorFixture(["Hugo 0.150.0"]));
		const entry = r.entries[0];
		assert.deepEqual(entry.groups, ["past"]);
		assert.equal(entry.group, "past");
		assert.equal(entry.groupName, "Emeritus");
	});

	test("does nothing to a group that declares no rule", async () => {
		const f = fixture({ sites: 2 });
		const r = await buildReport(f);
		assert.equal(r.emeritus.length, 0);
		assert.equal(groupOf(r, "g").entries.length, 2);
	});
});

describe("presumed generators", () => {
	/**
	 * A curated list is a claim about what built a site. Where nothing was
	 * detected, that claim is worth showing — but it must never behave like a
	 * measurement, and it must vanish the moment one contradicts it.
	 */
	function presumedFixture(generator) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-presumed-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));
		store.write({
			url: "https://site.example/",
			name: "Site",
			group: "curated",
			timestamp: Date.UTC(2026, 0, 1),
			date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			durationMs: 1000,
			error: null,
			lab: {
				requestedUrl: "https://site.example/",
				finalUrl: "https://site.example/",
				scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
				weight: { total: 1000, requests: 1, byType: {} },
				environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
			},
			axe: generator ? { generator: { raw: generator }, headers: {} } : null,
			field: null,
		});

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				curated: {
					name: "Curated",
					requireGenerator: ["eleventy", "build-awesome"],
					emeritusGroup: "past",
					presumedGenerator: "build-awesome",
					sites: [{ url: "https://site.example/" }],
				},
				past: { name: "Emeritus", sites: [] },
			} };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	test("stands in when nothing was detected", async () => {
		const r = await buildReport(presumedFixture(null));
		const entry = r.entries[0];
		assert.equal(entry.generator, null);
		assert.equal(entry.presumedGenerator.name, "Build Awesome");
		assert.equal(entry.presumedGenerator.presumed, true);
	});

	test("disappears once a real generator is detected", async () => {
		// The question this whole design turns on: nothing is stored, so the
		// presumption is simply not recomputed once evidence exists.
		const r = await buildReport(presumedFixture("Eleventy v3.1.6"));
		const entry = r.entries[0];
		assert.equal(entry.generator.name, "Eleventy");
		assert.equal(entry.presumedGenerator, undefined);
	});

	test("is never handed to a site on its way out of the category", async () => {
		// Detected as something else: it belongs to Emeritus, and must not pick up
		// the category's claim as it leaves.
		const r = await buildReport(presumedFixture("Astro v5.0.0"));
		const entry = r.entries[0];
		assert.deepEqual(entry.groups, ["past"]);
		assert.equal(entry.presumedGenerator, undefined);
	});

	test("never counts toward the Built with tally", async () => {
		// Otherwise every undetected site would inflate the numbers with guesses.
		const r = await buildReport(presumedFixture(null));
		assert.equal(r.stacks.generators.detected, 0);
		assert.equal(r.stacks.generators.unknown, 1);
	});
});

describe("returning to a category", () => {
	/**
	 * `11ty Emeritus` is defined by what a site *used* to be built with. One
	 * measuring as that thing again has come back, so leaving it there would
	 * state the opposite of the truth — the mirror image of requireGenerator.
	 */
	function emeritusFixture(generator) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-return-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));
		store.write({
			url: "https://site.example/",
			name: "Site",
			group: "past",
			timestamp: Date.UTC(2026, 0, 1),
			date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			durationMs: 1000,
			error: null,
			lab: {
				requestedUrl: "https://site.example/",
				finalUrl: "https://site.example/",
				scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
				weight: { total: 1000, requests: 1, byType: {} },
				environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
			},
			axe: generator ? { generator: { raw: generator }, headers: {} } : null,
			field: null,
		});

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				current: {
					name: "Current",
					requireGenerator: ["eleventy", "build-awesome"],
					emeritusGroup: "past",
					sites: [],
				},
				past: {
					name: "Past",
					rejectGenerator: ["eleventy", "build-awesome"],
					rejectGroup: "current",
					sites: [{ url: "https://site.example/" }],
				},
			} };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	const groupOf = (r, id) => r.groups.find((g) => g.id === id);

	test("a site rebuilt on the original generator moves back", async () => {
		const r = await buildReport(emeritusFixture("Eleventy v3.1.6"));
		assert.deepEqual(r.entries[0].groups, ["current"]);
		assert.equal(groupOf(r, "past").entries.length, 0);
		assert.equal(r.emeritus[0].to, "current");
	});

	test("the newer branding counts as a return too", async () => {
		const r = await buildReport(emeritusFixture("Build Awesome v4.0.0"));
		assert.deepEqual(r.entries[0].groups, ["current"]);
	});

	test("a site built with something else stays put", async () => {
		const r = await buildReport(emeritusFixture("Astro v5.0.0"));
		assert.deepEqual(r.entries[0].groups, ["past"]);
		assert.equal(r.emeritus.length, 0);
	});

	test("an undetected generator is not evidence of a return", async () => {
		const r = await buildReport(emeritusFixture(null));
		assert.deepEqual(r.entries[0].groups, ["past"]);
	});

	test("the two rules cannot bounce a site between them", async () => {
		// Whichever order they run in, a site the first rule moves has a generator
		// the second does not accept.
		for (let generator of ["Eleventy v3.1.6", "Astro v5.0.0"]) {
			const r = await buildReport(emeritusFixture(generator));
			assert.equal(r.entries[0].groups.length, 1, generator);
			assert.ok(r.emeritus.length <= 1, generator);
		}
	});
});

describe("fleet weight history", () => {
	/**
	 * The daily average is only meaningful once enough days exist. Over a short
	 * window the fleet's rolling schedule moves the line more than the sites do,
	 * so the report withholds the series rather than drawing a shape that is
	 * mostly sampling noise.
	 */
	function daysFixture(dayCount) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-weight-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));

		for (let d = 0; d < dayCount; d++) {
			store.write({
				url: "https://site.example/",
				name: "Site",
				group: "g",
				timestamp: Date.UTC(2026, 0, d + 1),
				date: new Date(Date.UTC(2026, 0, d + 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 1000,
				error: null,
				lab: {
					requestedUrl: "https://site.example/",
					finalUrl: "https://site.example/",
					scores: { performance: 90, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
					weight: { total: 500000 + d * 1000, requests: 10, byType: {} },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
				},
				field: null,
			});
		}

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { historyLimit: null, groups: { g: { name: "G", sites: [{ url: "https://site.example/" }] } } };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	test("is withheld below the minimum", async () => {
		const r = await buildReport(daysFixture(5));
		assert.deepEqual(r.stats.weightHistory, []);
	});

	test("appears once there is enough history", async () => {
		const r = await buildReport(daysFixture(14));
		assert.equal(r.stats.weightHistory.length, 14);
	});

	test("each point carries its date, average and sample size", async () => {
		const r = await buildReport(daysFixture(14));
		const first = r.stats.weightHistory[0];
		assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(first.avgWeight, 500000);
		assert.equal(first.sites, 1);
		// One measurement a day, ascending, so the series must ascend too.
		const values = r.stats.weightHistory.map((p) => p.avgWeight);
		assert.deepEqual(values, [...values].sort((a, b) => a - b));
	});

	test("is ordered oldest first, so a sparkline reads left to right", async () => {
		const r = await buildReport(daysFixture(14));
		const dates = r.stats.weightHistory.map((p) => p.date);
		assert.deepEqual(dates, [...dates].sort());
	});
});
