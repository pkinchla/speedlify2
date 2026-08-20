/**
 * Leaderboard ranking, ported from `performance-leaderboard`.
 *
 * https://www.zachleat.com/web/eleventy-leaderboard-speedlify/#the-algorithm-and-tiebreaker-changes
 *
 * Ordering, in sequence:
 *
 *  1. **Sum of all four Lighthouse categories** (0–400), higher wins. Using all
 *     four rather than Performance alone stops a fast but inaccessible site
 *     outranking a well-rounded one.
 *  2. **Fewest accessibility violations**, counted as violating *nodes*.
 *  3. **Tiebreaker value**, lower wins:
 *
 *         50000 * speedIndex / weight + TTFB + TBT
 *
 *     Speed Index per KB. The point is that a fast *heavy* site is more
 *     impressive than a fast empty one — so with Speed Index equal the larger
 *     site wins, and with weight equal the lower Speed Index wins. TTFB and TBT
 *     are added so server latency and main-thread blocking still cost you.
 *
 * The weight used in that ratio caps images and fonts, otherwise a site could
 * climb the board by shipping enormous images it doesn't need.
 */

/** Bytes past which extra images/fonts stop earning credit. */
const UPPER_LIMIT_IMAGES = 400000;
const UPPER_LIMIT_FONTS = 100000;

/** Scale factor, so the ratio lands in the same order of magnitude as ms. */
const SPEED_INDEX_SCALE = 50000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Sum of the four Lighthouse categories, 0–400. Null if any is missing. */
export function lighthouseSum(entry) {
	const scores = entry?.latest?.lab?.scores;
	if (!scores) return null;

	const parts = [scores.performance, scores.accessibility, scores["best-practices"], scores.seo].map(num);
	if (parts.some((v) => v === null)) return null;

	return parts.reduce((a, b) => a + b, 0);
}

/**
 * The weight the Speed Index is measured against.
 *
 * Document, CSS and JS count in full — those are the bytes you chose to ship.
 * Images and fonts are capped so that padding them cannot buy you rank.
 */
export function tiebreakerWeight(entry) {
	const byType = entry?.latest?.lab?.weight?.byType;
	if (!byType) return null;

	const bytes = (key) => num(byType[key]?.bytes) ?? 0;

	return (
		bytes("document") +
		bytes("stylesheet") +
		bytes("script") +
		Math.min(bytes("font"), UPPER_LIMIT_FONTS) +
		Math.min(bytes("image"), UPPER_LIMIT_IMAGES)
	);
}

/** Speed Index per KB, plus TTFB and TBT. Lower is better. */
export function tiebreakerValue(entry) {
	const timings = entry?.latest?.lab?.timings;
	if (!timings) return null;

	const speedIndex = num(timings.si);
	if (speedIndex === null) return null;

	const weight = tiebreakerWeight(entry);
	if (weight === null) return null;

	// A zero-weight page would divide to Infinity; clamping keeps it merely
	// terrible rather than unsortable.
	const divisor = Math.max(weight, 1);

	return SPEED_INDEX_SCALE * (speedIndex / divisor) + (num(timings.ttfb) ?? 0) + (num(timings.tbt) ?? 0);
}

/**
 * Accessibility violations from the standalone axe run, counted as violating
 * nodes rather than broken rules.
 *
 * This is deliberately not Lighthouse's accessibility audit. Lighthouse runs a
 * subset of axe's rules and folds the outcome into a weighted score; a page can
 * score in the nineties there and still fail a dozen axe checks. The tiebreaker
 * wants the strict count.
 *
 * Returns null when axe did not run or errored, which the comparator treats as
 * "no data" rather than "no violations" — otherwise a site whose axe pass timed
 * out would win the tiebreaker for it.
 */
export function accessibilityViolations(entry) {
	return num(entry?.latest?.axe?.violations);
}

/**
 * How many Core Web Vitals are failing at p75, from real user data.
 *
 * Counting *failures* rather than passes is what makes partial coverage fair:
 * CrUX reports different metrics for different sites (a quiet site may have LCP
 * and CLS but no INP), so "2 good" means nothing without its denominator, while
 * "0 failing" means the same thing whether two metrics were assessed or three.
 *
 * Returns null — meaning "not assessed", not "perfect" — when:
 *  - the site has no CrUX data, or
 *  - the assessment came from the **lab approximation**. That is derived from
 *    the same lab timings already counted in the Lighthouse total, so letting
 *    it in here would score the same numbers twice and let a site with no real
 *    users compete against sites judged on actual traffic.
 */
export function coreWebVitalFailures(entry) {
	const cwv = entry?.cwv;
	if (!cwv || cwv.source === "lab") return null;

	const rated = cwv.parts.filter((p) => p.rating);
	if (!rated.length) return null;

	return rated.filter((p) => p.rating !== "good").length;
}

/**
 * The comparator. Sorts best first.
 *
 * Sites with no successful measurement sort last rather than being treated as
 * a zero score — never measured is not the same as measured badly.
 */
/** Lower wins, with null ("not assessed") sorting after any real value. */
function byLowest(aValue, bValue) {
	if (aValue === bValue) return 0;
	if (aValue === null) return 1;
	if (bValue === null) return -1;
	return aValue - bValue;
}

export const RANKING_DEFAULTS = {
	// Include real-user Core Web Vitals as a tier. Turn off to rank purely on
	// what a synthetic run can reproduce.
	useFieldData: true,
	// Where that tier sits: "afterTotal" (ahead of axe) or "last" (final
	// tiebreak, so it only separates otherwise-identical sites).
	fieldDataTier: "afterTotal",
};

/**
 * Build the comparator. Sorts best first.
 *
 * A note on why this is a factory: the position of the field-data tier changes
 * the leaderboard substantially, so it is a configuration decision rather than
 * something baked in.
 */
export function createComparator(options = {}) {
	const { useFieldData, fieldDataTier } = { ...RANKING_DEFAULTS, ...options };

	return function compare(a, b) {
		const aMeasured = Boolean(a?.latest);
		const bMeasured = Boolean(b?.latest);
		if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;
		if (!aMeasured) return 0;

		// 1. Total Lighthouse score, higher wins.
		const aSum = lighthouseSum(a);
		const bSum = lighthouseSum(b);
		if (aSum !== bSum) {
			if (aSum === null) return 1;
			if (bSum === null) return -1;
			return bSum - aSum;
		}

		// 2. Failing Core Web Vitals from real users, fewest wins.
		//
		//    Deliberately ahead of axe and the lab tiebreaker: once two sites
		//    score the same in the lab, what actually happened to real people is
		//    the better evidence. A site with no CrUX coverage is not assessed
		//    here and falls through to the tiers below — it is neither credited
		//    nor blamed for data that does not exist.
		if (useFieldData && fieldDataTier === "afterTotal") {
			const cwv = compareFieldFailures(a, b);
			if (cwv !== 0) return cwv;
		}

		// 3. Fewest accessibility violations.
		const axe = byLowest(accessibilityViolations(a), accessibilityViolations(b));
		if (axe !== 0) return axe;

		// 4. Speed Index per KB, plus TTFB and TBT. Lower wins.
		const tie = byLowest(tiebreakerValue(a), tiebreakerValue(b));
		if (tie !== 0) return tie;

		// 5. Field data as a final separator, when configured that way.
		if (useFieldData && fieldDataTier === "last") {
			return compareFieldFailures(a, b);
		}

		return 0;
	};
}

/**
 * Compare failing Core Web Vitals, treating "not assessed" as **no known
 * failures** rather than as worse than everyone.
 *
 * This is the difference between a tier that demotes sites for failing real
 * users and one that demotes them for being small. Sorting unassessed sites
 * last did the latter: vuepress.vuejs.org, whose CrUX record has no rated
 * metrics, was pushed below a site with thirteen accessibility violations that
 * it otherwise beat — the axe tier was never reached.
 *
 * Absence of evidence is not evidence of failure, so an unassessed site is
 * neither credited nor blamed here and simply carries on to the next tier.
 * Skipping the tier outright would be the other way to express that, but a
 * comparator that ignores a criterion for some pairs and not others is not
 * transitive, and an intransitive comparator makes the sort order undefined.
 */
function compareFieldFailures(a, b) {
	return (coreWebVitalFailures(a) ?? 0) - (coreWebVitalFailures(b) ?? 0);
}

/** The default comparator, using the settings above. */
export const compareEntries = createComparator();

/**
 * Rank a list with the leaderboard algorithm.
 *
 * Genuinely equal entries share a rank and the next position skips, the same
 * way the per-metric rankings behave. In practice the tiebreaker is continuous
 * enough that exact ties are rare.
 */
export function rankLeaderboard(entries, compare = compareEntries) {
	const sorted = [...entries].sort(compare);

	let lastRank = 0;
	return sorted.map((entry, i) => {
		const tied = i > 0 && compare(sorted[i - 1], entry) === 0;
		const rank = tied ? lastRank : i + 1;
		lastRank = rank;
		return { entry, rank };
	});
}
