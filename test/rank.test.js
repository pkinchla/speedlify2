import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	lighthouseSum,
	tiebreakerWeight,
	tiebreakerValue,
	accessibilityViolations,
	compareEntries,
	createComparator,
	coreWebVitalFailures,
	rankLeaderboard,
} from "../lib/rank.js";
import { countNodes } from "../lib/axe.js";

/**
 * The leaderboard algorithm, ported from performance-leaderboard:
 *   1. sum of all four Lighthouse categories, higher wins
 *   2. fewest axe violations (nodes), lower wins
 *   3. 50000 * speedIndex / weight + TTFB + TBT, lower wins
 */

function entry({
	performance = 100,
	accessibility = 100,
	bestPractices = 100,
	seo = 100,
	si = 1000,
	ttfb = 100,
	tbt = 0,
	document = 10000,
	stylesheet = 10000,
	script = 10000,
	font = 0,
	image = 0,
	violations = 0,
	axe = true,
	measured = true,
} = {}) {
	if (!measured) return { latest: null };

	return {
		latest: {
			lab: {
				scores: { performance, accessibility, "best-practices": bestPractices, seo },
				timings: { si, ttfb, tbt },
				weight: {
					byType: {
						document: { bytes: document },
						stylesheet: { bytes: stylesheet },
						script: { bytes: script },
						font: { bytes: font },
						image: { bytes: image },
					},
				},
			},
			axe: axe ? { violations } : null,
		},
	};
}

describe("lighthouseSum", () => {
	test("adds all four categories", () => {
		assert.equal(lighthouseSum(entry()), 400);
		assert.equal(lighthouseSum(entry({ performance: 50, seo: 90 })), 340);
	});

	test("is null when a category is missing", () => {
		const e = entry();
		delete e.latest.lab.scores.seo;
		assert.equal(lighthouseSum(e), null);
	});
});

describe("tiebreakerWeight", () => {
	test("counts document, CSS and JS in full", () => {
		assert.equal(tiebreakerWeight(entry({ document: 1000, stylesheet: 2000, script: 3000 })), 6000);
	});

	test("caps fonts at 100kB", () => {
		const under = tiebreakerWeight(entry({ document: 0, stylesheet: 0, script: 0, font: 50000 }));
		const over = tiebreakerWeight(entry({ document: 0, stylesheet: 0, script: 0, font: 999999 }));
		assert.equal(under, 50000);
		assert.equal(over, 100000, "extra font bytes must not buy rank");
	});

	test("caps images at 400kB", () => {
		const over = tiebreakerWeight(entry({ document: 0, stylesheet: 0, script: 0, image: 5_000_000 }));
		assert.equal(over, 400000, "extra image bytes must not buy rank");
	});
});

describe("tiebreakerValue", () => {
	test("is Speed Index per weight, plus TTFB and TBT", () => {
		// 50000 * 1000 / 30000 = 1666.67, + 100 TTFB + 50 TBT
		const v = tiebreakerValue(entry({ si: 1000, ttfb: 100, tbt: 50 }));
		assert.ok(Math.abs(v - (50000 * (1000 / 30000) + 150)) < 0.001);
	});

	test("with Speed Index equal, the heavier site wins", () => {
		const light = tiebreakerValue(entry({ si: 1000, document: 1000, stylesheet: 0, script: 0 }));
		const heavy = tiebreakerValue(entry({ si: 1000, document: 100000, stylesheet: 0, script: 0 }));
		assert.ok(heavy < light, "being fast while heavy is more impressive");
	});

	test("with weight equal, the lower Speed Index wins", () => {
		const slow = tiebreakerValue(entry({ si: 4000 }));
		const fast = tiebreakerValue(entry({ si: 1000 }));
		assert.ok(fast < slow);
	});

	test("TTFB and TBT still cost you", () => {
		const clean = tiebreakerValue(entry({ ttfb: 0, tbt: 0 }));
		const slowServer = tiebreakerValue(entry({ ttfb: 500, tbt: 0 }));
		const blocking = tiebreakerValue(entry({ ttfb: 0, tbt: 500 }));

		// Both are added to the ratio verbatim, within float tolerance.
		assert.ok(Math.abs(slowServer - clean - 500) < 1e-6);
		assert.ok(Math.abs(blocking - clean - 500) < 1e-6);
	});

	test("does not divide by zero on a weightless page", () => {
		const v = tiebreakerValue(entry({ document: 0, stylesheet: 0, script: 0 }));
		assert.ok(Number.isFinite(v));
	});
});

describe("compareEntries", () => {
	const first = (a, b) => (compareEntries(a, b) < 0 ? "a" : "b");

	test("total Lighthouse score decides before anything else", () => {
		// b is worse on every tiebreaker but has the higher total.
		const a = entry({ performance: 90, violations: 0, si: 500 });
		const b = entry({ performance: 100, violations: 50, si: 9000 });
		assert.equal(first(a, b), "b");
	});

	test("uses all four categories, not performance alone", () => {
		// Same total, but reached differently — neither wins on step 1.
		const a = entry({ performance: 100, accessibility: 80 });
		const b = entry({ performance: 80, accessibility: 100 });
		assert.equal(lighthouseSum(a), lighthouseSum(b));

		// A fast but inaccessible site does not automatically win.
		const fastInaccessible = entry({ performance: 100, accessibility: 60 });
		const balanced = entry({ performance: 90, accessibility: 90 });
		assert.equal(first(fastInaccessible, balanced), "b");
	});

	test("axe violations break a tied score", () => {
		const clean = entry({ violations: 0, si: 3000 });
		const dirty = entry({ violations: 12, si: 500 });
		assert.equal(first(clean, dirty), "a", "fewer violations wins even if slower");
	});

	test("Speed Index per KB breaks a tie when violations match", () => {
		const heavy = entry({ violations: 0, si: 1000, script: 500000 });
		const light = entry({ violations: 0, si: 1000, script: 1000 });
		assert.equal(first(heavy, light), "a");
	});

	test("a site with no axe data sorts after one that has it", () => {
		const withAxe = entry({ violations: 5 });
		const withoutAxe = entry({ axe: false });
		assert.equal(first(withAxe, withoutAxe), "a", "missing data must not win the tiebreaker");
	});

	test("unmeasured sites sort last, not as a zero score", () => {
		const measured = entry({ performance: 10, accessibility: 10, bestPractices: 10, seo: 10 });
		const never = entry({ measured: false });
		assert.equal(first(measured, never), "a");
		assert.equal(compareEntries(never, entry({ measured: false })), 0);
	});

	test("is a consistent comparator", () => {
		const list = [
			entry({ performance: 90, violations: 3 }),
			entry({ performance: 100, violations: 0 }),
			entry({ performance: 100, violations: 5 }),
			entry({ measured: false }),
		];

		const sorted = [...list].sort(compareEntries);
		// Sorting an already-sorted list must not reorder it.
		assert.deepEqual([...sorted].sort(compareEntries), sorted);
	});
});

describe("rankLeaderboard", () => {
	test("ranks best first and shares a rank on a genuine tie", () => {
		const a = entry({ performance: 100 });
		const b = entry({ performance: 100 });
		const c = entry({ performance: 50 });

		const ranked = rankLeaderboard([c, a, b]);
		assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3]);
	});

	test("does not mutate the input order", () => {
		const list = [entry({ performance: 50 }), entry({ performance: 100 })];
		const before = [...list];
		rankLeaderboard(list);
		assert.deepEqual(list, before);
	});
});

describe("countNodes", () => {
	test("counts violating nodes, not rules", () => {
		// One rule broken across eight elements is eight violations.
		assert.equal(countNodes([{ nodes: new Array(8) }]), 8);
		assert.equal(countNodes([{ nodes: new Array(3) }, { nodes: new Array(2) }]), 5);
	});

	test("counts a rule with no nodes as one", () => {
		assert.equal(countNodes([{ nodes: [] }]), 1);
	});

	test("handles an empty or missing list", () => {
		assert.equal(countNodes([]), 0);
		assert.equal(countNodes(undefined), 0);
	});
});

describe("accessibilityViolations", () => {
	test("reads the standalone axe count, not the Lighthouse audit", () => {
		const e = entry({ violations: 7 });
		// Lighthouse's own a11y numbers must not be used as a substitute.
		e.latest.lab.accessibility = { failingNodes: 99, failingCount: 40 };
		assert.equal(accessibilityViolations(e), 7);
	});

	test("is null when axe did not run", () => {
		assert.equal(accessibilityViolations(entry({ axe: false })), null);
	});
});

describe("Core Web Vitals tier", () => {
	const withCwv = (opts, cwv) => ({ ...entry(opts), cwv });
	const field = (...ratings) => ({
		source: "field-history",
		parts: ["lcp", "inp", "cls"].map((key, i) => ({ key, rating: ratings[i] ?? null })),
	});

	const first = (a, b) => (createComparator({})(a, b) < 0 ? "a" : "b");

	test("counts failing vitals, not passing ones", () => {
		assert.equal(coreWebVitalFailures(withCwv({}, field("good", "good", "good"))), 0);
		assert.equal(coreWebVitalFailures(withCwv({}, field("good", "poor", "good"))), 1);
		assert.equal(coreWebVitalFailures(withCwv({}, field("poor", "poor", "needs-improvement"))), 3);
	});

	test("partial coverage is judged only on what was assessed", () => {
		// Two of three rated, both good — as clean as three of three.
		assert.equal(coreWebVitalFailures(withCwv({}, field("good", null, "good"))), 0);
	});

	test("ignores the lab approximation entirely", () => {
		const lab = { source: "lab", parts: [{ key: "lcp", rating: "poor" }] };
		assert.equal(
			coreWebVitalFailures(withCwv({}, lab)),
			null,
			"the approximation is derived from lab timings already counted in the total"
		);
	});

	test("is null when nothing was rated", () => {
		assert.equal(coreWebVitalFailures(withCwv({}, field(null, null, null))), null);
		assert.equal(coreWebVitalFailures(entry()), null);
	});

	test("failing real-user vitals lose to passing ones at the same total", () => {
		const passes = withCwv({ violations: 5 }, field("good", "good", "good"));
		const fails = withCwv({ violations: 0 }, field("poor", "good", "good"));
		assert.equal(first(passes, fails), "a", "field failures outrank a better axe score");
	});

	test("a site with no field data is not demoted by the tier", () => {
		// The regression this tier originally introduced: an unassessed site was
		// sorted below one with far worse accessibility, because "no data" was
		// treated as worse than "no failures".
		const assessed = withCwv({ violations: 13 }, field("good", "good", "good"));
		const unassessed = withCwv({ violations: 2 }, field(null, null, null));

		assert.equal(first(assessed, unassessed), "b", "the axe tier must still decide this pair");
	});

	test("an unassessed site still loses to nothing on field data alone", () => {
		const unassessed = withCwv({ violations: 0 }, field(null, null, null));
		const failing = withCwv({ violations: 0 }, field("poor", "poor", "poor"));
		assert.equal(first(unassessed, failing), "a", "proven failure ranks below unknown");
	});

	test("can be turned off entirely", () => {
		const passes = withCwv({ violations: 5 }, field("good", "good", "good"));
		const fails = withCwv({ violations: 0 }, field("poor", "good", "good"));

		const off = createComparator({ useFieldData: false });
		assert.ok(off(passes, fails) > 0, "with the tier off, axe decides and the cleaner site wins");
	});

	test("remains a consistent comparator", () => {
		const list = [
			withCwv({ violations: 1 }, field("good", "good", "good")),
			withCwv({ violations: 0 }, field("poor", "good", "good")),
			withCwv({ violations: 3 }, field(null, null, null)),
			entry({ measured: false }),
		];
		const cmp = createComparator({});
		const sorted = [...list].sort(cmp);
		assert.deepEqual([...sorted].sort(cmp), sorted);
	});
});
