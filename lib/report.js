import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ResultStore } from "./store.js";
import { trend, rank, isSignificant, environmentDrift, labVsField } from "./compare.js";
import { readAliases, resolveHistoryUrls, applyAliases } from "./aliases.js";
import { urlHash, distinctUrls, normalizeUrl, shortHash } from "./hash.js";
import { assignSlugs } from "./slug.js";
import { confirmRedirect } from "./redirect.js";
import { detectHost, detectGenerator, generatorById } from "./stack.js";
import {
	createComparator,
	rankLeaderboard,
	lighthouseSum,
	tiebreakerValue,
	tiebreakerWeight,
	accessibilityViolations,
	coreWebVitalFailures,
} from "./rank.js";
import {
	SCORES,
	LAB_METRICS,
	FIELD_METRICS,
	WEIGHT_METRICS,
	HEALTH_METRICS,
} from "./report-metrics.js";

export const REPORT_VERSION = 1;

/**
 * Build the report: every configured site joined to its stored history, with
 * all trends, rankings and comparisons already computed.
 *
 * This is the whole analysis layer, and it runs as its own step rather than
 * inside the site build. Two things fall out of that:
 *
 *  - The Eleventy build becomes a pure render of one JSON file. It touches no
 *    measurements, so it cannot rebuild a series cache as a side effect and
 *    works fine against a read-only checkout.
 *  - The report is a publishable artifact in its own right — the same numbers
 *    the site shows, in a form something else can consume.
 */
export async function buildReport({
	resultsDir = process.env.SPEEDLIFY_RESULTS_DIR || "results",
	configFile = "config/sites.js",
	// Whether Core Web Vitals are being collected at all. Without a CrUX key
	// there is no INP and no field data, so the only thing we could show is a
	// lab approximation — and presenting that as "Core Web Vitals" would imply a
	// measurement that isn't happening.
	cruxEnabled = Boolean(process.env.CRUX_API_KEY),
	now = Date.now(),
} = {}) {
	const config = await loadConfig(configFile);
	const store = new ResultStore(resultsDir);

	const context = { resultsDir, cruxEnabled, weightByDay: {} };

	// Ranking is configurable because where field data sits materially changes
	// the leaderboard.
	const compare = createComparator(config.ranking);

	// Confirmed URL moves, so a site that changed address keeps one continuous
	// history instead of restarting from zero.
	const { aliases } = readAliases(resultsDir);

	// Same resolution the measure step uses, so the report describes where each
	// site lives now rather than where the config last said it lived.
	const sites = applyAliases(config.sites, aliases, urlHash);

	context.displayUrls = distinctUrls(sites.map((s) => s.url));
	// A collision means two sites want one filename, and the embed component —
	// which derives the slug in the browser with no index to check — would find
	// the wrong one. Both fall back to their hash instead, which is loud here
	// and inert there.
	const slugCollisions = [];
	context.slugs = assignSlugs(
		sites.map((s) => s.url),
		{
			onCollision(slug, urls) {
				slugCollisions.push({ slug, urls });
			},
		},
	);
	context.slugCollisions = slugCollisions;

	const entries = sites.map((site) => buildEntry(site, store, config, now, aliases, context));

	// Membership can depend on what was measured, not only on what was configured.
	const emeritus = applyGeneratorRules(entries, config);

	// Strictly after reclassification: a site that just measured as Astro belongs
	// to Emeritus, and must not be handed a presumed Build Awesome mark on its
	// way out.
	applyPresumedGenerators(entries, config);
	flagUnlisted(entries, config);

	// Rank globally first, then within each group. These write to different
	// keys on purpose: entries are shared object references, so a single `ranks`
	// field would have the second pass silently overwrite the first and a site
	// would show its global position inside a group table.
	rankEntries(entries, "ranks", compare);

	const groups = Object.entries(config.groups).map(([id, group]) => {
		const groupEntries = entries.filter((e) => (e.groups || [e.group]).includes(id));
		rankEntries(groupEntries, `groupRanks:${id}`, compare);

		return {
			id,
			name: group.name || id,
			description: group.description || "",
			entries: sortByLeaderboard(groupEntries, compare),
			measured: groupEntries.filter((e) => e.latest).length,
			// How many entries have enough history for significance testing.
			comparable: groupEntries.filter((e) => e.historyCount >= 3).length,
		};
	});

	return {
		version: REPORT_VERSION,
		config: {
			runs: config.runs,
			formFactor: config.formFactor,
			ranking: config.ranking,
		},
		// Row definitions, so report.json is renderable without this codebase.
		metrics: { SCORES, LAB_METRICS, FIELD_METRICS, WEIGHT_METRICS, HEALTH_METRICS },
		entries: sortByLeaderboard(entries, compare),
		groups,
		// Sites whose stored history no longer matches anything in config —
		// usually a URL that was edited or removed. Surfaced so history isn't
		// silently orphaned.
		// A predecessor URL is no longer an orphan — its history has been merged
		// into the site that succeeded it.
		orphans: findOrphans(entries, store, resultsDir),
		// Sites reclassified out of a category by what their generator turned out
		// to be — see `requireGenerator` in config/sites.js.
		emeritus,
		// Sites whose slug was taken, and which fell back to a hash. Empty is the
		// normal state; anything here is a site whose embed has gone quiet.
		slugCollisions: context.slugCollisions,
		// Sites currently redirecting somewhere that isn't yet being measured.
		// Informational only — once a redirect is confirmed, measurement follows
		// it on its own. This is the waiting room, not a to-do list.
		moving: entries
			.filter((e) => e.redirectTo && e.redirectTo !== e.url)
			.map((e) => ({
				name: e.name,
				hash: e.hash,
				slug: e.slug,
				// Which categories the URL sits in — a redirect in a curated list
				// means something different from one in the address book.
				groups: e.groupNames,
				from: e.url,
				to: e.redirectTo,
				confirmed: e.redirectConfirmed,
				reason: e.redirectReason,
			})),
		// Moves already followed automatically, with no config change.
		autoMoved: entries
			.filter((e) => e.movedAutomatically)
			.map((e) => ({ hash: e.hash, slug: e.slug, from: e.configuredUrl, to: e.url })),
		moved: entries
			.filter((e) => e.movedFrom)
			.map((e) => ({ name: e.name, hash: e.hash, slug: e.slug, from: e.movedFrom, to: e.url })),
		stats: { ...buildStats(entries), weightHistory: buildWeightHistory(context.weightByDay) },
		// What the fleet is built with and hosted on.
		stacks: buildStacks(entries),
		coverage: buildCoverage(entries, config),
		generated: new Date().toISOString(),
		// Either source counts — a backfilled history is field data too.
		hasFieldData: entries.some((e) => e.latest?.field || e.fieldHistory?.series?.length),
		cruxEnabled,
		// Whether any site has a Core Web Vitals assessment to show. Templates
		// branch on this rather than on the key, so a build with stored field
		// data still renders it.
		cwvAvailable: entries.some((e) => e.cwv),
	};
}

/**
 * Move sites out of a category when the generator says they no longer belong.
 *
 * A curated list is a record of what was submitted, which drifts from what is
 * true — a site rebuilt on something else is still on the list. A group can
 * declare `requireGenerator: [...ids]` plus an `emeritusGroup` to receive the
 * ones that no longer qualify.
 *
 * The inverse exists too: `rejectGenerator` plus a `rejectGroup`, for a category
 * defined by what a site *used* to be built with. One measuring as that thing
 * again has come back, and leaving it there would state the opposite.
 *
 * Three deliberate choices:
 *
 *  - **Undetected is not disqualifying.** Most static sites emit no generator
 *    tag at all, so `null` proves nothing and those entries stay put. Only a
 *    positively identified *other* generator moves a site.
 *  - **Only the one membership moves.** A site in both this category and the
 *    address book keeps the address book.
 *  - **Nothing stops being measured.** This reshapes presentation only; the
 *    site stays in `config.sites`, which is what lets it come home by itself if
 *    it is ever rebuilt on the original generator.
 */
function applyGeneratorRules(entries, config) {
	const moved = [];

	/**
	 * One direction of the rule.
	 *
	 * `keep` decides membership: a site whose detected generator fails the test
	 * does not belong in `groupId` and is moved to `destination`.
	 */
	function reassign(groupId, destination, keep, label) {
		if (!config.groups[destination]) {
			throw new Error(`Group "${groupId}" names ${label} "${destination}", which is not defined.`);
		}

		for (let entry of entries) {
			if (!entry.groups.includes(groupId)) continue;

			// No detection, or nothing we recognise: not evidence of anything.
			const id = entry.generator?.id;
			if (!id || keep(id)) continue;

			entry.groups = entry.groups.filter((g) => g !== groupId);
			if (!entry.groups.includes(destination)) entry.groups.push(destination);

			// `group` and its display names were resolved from the old membership.
			entry.group = entry.groups[0];
			entry.groupName = config.groups[entry.group]?.name || entry.group;
			entry.groupNames = entry.groups.map((g) => config.groups[g]?.name || g);

			moved.push({
				url: entry.url,
				slug: entry.slug,
				from: groupId,
				to: destination,
				generator: entry.generator.name,
			});
		}
	}

	for (let [groupId, group] of Object.entries(config.groups)) {
		// Built with something else, so it has moved on.
		if (group.requireGenerator?.length && group.emeritusGroup) {
			reassign(groupId, group.emeritusGroup, (id) => group.requireGenerator.includes(id), "emeritusGroup");
		}

		// The inverse: this category is for sites that *used* to be built with
		// something. One measuring as that thing again has come back, and saying
		// otherwise would be false.
		//
		// Safe to run alongside the rule above in either order: a site the first
		// rule moves out has a generator the second rule does not accept, so it
		// cannot be bounced back on the same pass.
		if (group.rejectGenerator?.length && group.rejectGroup) {
			reassign(groupId, group.rejectGroup, (id) => !group.rejectGenerator.includes(id), "rejectGroup");
		}
	}

	return moved;
}

/**
 * Mark what a category *claims* built a site, where nothing was detected.
 *
 * Most static sites emit no `meta[name=generator]` at all, so a blank is the
 * ordinary case rather than a suspicious one. A curated list is itself a claim
 * — someone submitted the site as built with a particular thing — and that is
 * worth showing, provided it never passes for a measurement.
 *
 * Three things keep the two apart:
 *
 *  - **Derived every build, never stored.** The moment a site emits a real
 *    generator tag, `entry.generator` fills in and this is simply not set on
 *    the next report. Nothing has to be cleaned up, and a wrong guess cannot
 *    outlive the evidence that contradicts it.
 *  - **Never counted.** `buildStacks` tallies `entry.generator` only, so a
 *    presumption cannot inflate the Built with numbers with guesses.
 *  - **Never qualifying.** `requireGenerator` reads `entry.generator` too, so a
 *    presumed mark cannot keep a site in a category it no longer belongs to.
 */
/**
 * Flag sites built with a generator that some category is the register for,
 * but which are not in that category.
 *
 * No new configuration: `requireGenerator` already says "this group is the list
 * of sites built with these things". A site built with one of them and absent
 * from the group is, by that same statement, missing from the list — which for
 * a community-submitted register is a submission nobody has made yet.
 *
 * Detections only. A presumed mark comes *from* the listing, so treating it as
 * evidence here would be circular — and would flag every unlisted site whose
 * generator we never saw.
 */
function flagUnlisted(entries, config) {
	for (let [groupId, group] of Object.entries(config.groups)) {
		if (!group.requireGenerator?.length) continue;

		// Categories that stand in for membership of this register. A site pulled
		// out of the register into a category of its own — starters, say — is
		// still listed upstream; only its presentation moved. Flagging it as
		// missing would be telling you to submit something already submitted.
		const listed = new Set([
			groupId,
			...Object.entries(config.groups)
				.filter(([, other]) => other.listedIn === groupId)
				.map(([id]) => id),
		]);

		for (let entry of entries) {
			if (entry.groups.some((id) => listed.has(id))) continue;

			const id = entry.generator?.id;
			if (!id || !group.requireGenerator.includes(id)) continue;

			entry.unlisted = {
				group: groupId,
				groupName: group.name || groupId,
				generator: entry.generator.name,
			};
		}
	}
}

function applyPresumedGenerators(entries, config) {
	for (let [groupId, group] of Object.entries(config.groups)) {
		if (!group.presumedGenerator) continue;

		const presumed = generatorById(group.presumedGenerator);
		if (!presumed) {
			throw new Error(
				`Group "${groupId}" names presumedGenerator "${group.presumedGenerator}", which is not a known generator.`,
			);
		}

		for (let entry of entries) {
			// A detection always wins, and a site only presumed to be measured is
			// not presumed to be anything.
			if (!entry.groups.includes(groupId) || entry.generator || !entry.latest) continue;
			entry.presumedGenerator = { ...presumed, presumed: true, source: groupId };
		}
	}
}

function buildEntry(site, store, config, now, aliases, context) {
	// Every URL this site has lived at, oldest first.
	const historyUrls = resolveHistoryUrls(site.url, aliases, site.previousUrls);
	const predecessors = historyUrls.slice(0, -1);

	// The whole chartable history in one compact file per URL. Everything below
	// reads from this rather than the archive, which is what keeps build cost
	// independent of how many years of measurements a site has.
	const series = mergeSeries(store, historyUrls);
	const totalCount = historyUrls.reduce((sum, u) => sum + store.count(u), 0);

	// Optionally chart only the tail. The full series is cheap enough that this
	// is a display choice now rather than a memory guard.
	const history = config.historyLimit ? series.slice(-config.historyLimit) : series;

	// Fleet-wide weight history, gathered here because the full series is already
	// loaded. One bucket per day, holding every measurement taken that day.
	for (let point of series) {
		if (point.error || typeof point.total !== "number") continue;
		const day = new Date(point.t).toISOString().slice(0, 10);
		(context.weightByDay[day] ??= []).push(point.total);
	}

	const successPoints = history.filter((p) => !p.error);
	const latestPoint = history[history.length - 1] || null;

	// A category may set its own staleness threshold — thousands of personal
	// sites on a weekly cycle should not all read as overdue against a target
	// meant for a handful of framework home pages.
	const staleAfterHours = site.staleAfterHours ?? config.staleAfterHours;

	// The one full record the report actually needs: newest successful, for the
	// detail panels (third parties, a11y failures, hygiene, resource split).
	//
	// Searched newest URL first across the whole move chain — a site that just
	// changed address has no records under its new URL yet, and falling back to
	// the previous one keeps its detail panels rather than blanking the page.
	const latest = successPoints.length ? latestSuccessAcross(store, historyUrls) : null;

	// The URL the site redirected us to, when it differs from the one we asked
	// for by nothing but a trailing slash. A real move is handled by the redirect
	// machinery instead; this is the small case that machinery ignores.
	const finalUrl = latest?.lab?.finalUrl ?? null;
	const canonicalUrl =
		finalUrl && finalUrl !== site.url && normalizeUrl(finalUrl) === normalizeUrl(site.url)
			? finalUrl
			: null;

	// Redirect state from the newest point, and whether it is confirmed enough
	// to have been learned as an alias.
	//
	// Re-tested against the current normalization rather than trusted as stored,
	// the same way host and generator are. A point recorded before trailing
	// slashes collapsed still carries `/en` -> `/en/` as a move; under today's
	// rule that is one URL, and reading the stored value would keep reporting a
	// site as moving to itself until it happened to be measured again.
	const storedTo = latestPoint?.to || null;
	const redirectTo = storedTo && normalizeUrl(storedTo) !== normalizeUrl(site.url) ? storedTo : null;
	const redirectVerdict = redirectTo ? confirmRedirect(series, { confirmations: config.redirectConfirmations }) : null;

	// Read once: the CWV assessment falls back to it when a measurement has no
	// field data of its own.
	const fieldHistory = readFieldHistory(context.resultsDir, site.hash);

	const lastAt = store.lastMeasuredAt(site.url);
	const ageHours = lastAt === null ? null : (now - lastAt) / 3600000;
	const dataAgeHours = latest ? (now - latest.timestamp) / 3600000 : null;

	// Built before the return so the ranking value below can read it.
	const cwv = coreWebVitals(latest, context.cruxEnabled, fieldHistory);

	const trends = {};
	for (let metric of [...SCORES, ...LAB_METRICS, ...WEIGHT_METRICS, ...HEALTH_METRICS]) {
		// Series points are flat, so the metric key is the lookup.
		const t = trend(history, metric.key, metric.key);
		if (t) trends[metric.key] = slimTrend(t, metric);
	}

	for (let metric of FIELD_METRICS) {
		const key = `field-${metric.key}`;
		const t = trend(history, key, metric.key);
		if (t) trends[key] = slimTrend(t, metric);
	}

	return {
		...site,
		// Shown instead of the configured name throughout the site.
		displayUrl: context.displayUrls.get(site.url) || site.url,
		// The site page's path segment. Separate from `hash`, which still keys
		// stored history and the embed API — those must stay stable, this only
		// has to stay readable.
		slug: context.slugs.get(site.url) || site.hash,
		// Only for the compatibility routes — see src/api-compat-*.njk. Not an
		// identifier this project uses for anything of its own.
		shortHash: shortHash(site.url),
		// Only what the history table renders. Trends were computed from the
		// full window above and carry their own values, so emitting every point
		// again here would be the same duplication in a second place.
		history: history.slice(-(config.logRows ?? 30)),
		// Points charted vs total on disk — they differ once a site has more
		// history than the window.
		historyCount: history.length,
		totalCount,
		windowed: totalCount > history.length,
		latest,
		// A site that is currently failing still has a latest *successful*
		// record; showing both keeps a broken site visible instead of frozen at
		// its last good numbers.
		currentlyFailing: Boolean(latestPoint?.error),
		lastError: latestPoint?.error || null,
		consecutiveFailures: latestPoint?.error ? latestPoint.fails || 1 : 0,
		firstMeasured: series[0]?.date || null,
		lastMeasured: latestPoint?.date || null,
		// URL history: where this site used to live, and where it appears to be
		// heading if it is currently redirecting somewhere new.
		previousUrls: predecessors,
		movedFrom: predecessors.length ? predecessors[predecessors.length - 1] : null,
		// True when the config still names an older URL and the move was followed
		// automatically from a confirmed redirect.
		movedAutomatically: Boolean(site.movedAutomatically),
		configuredUrl: site.configuredUrl || site.url,
		moveAt: predecessors.length ? findMoveBoundary(series) : null,
		redirectTo,
		redirectConfirmed: Boolean(redirectVerdict?.confirmed),
		redirectReason: redirectVerdict?.reason || null,
		// Which form of the URL the site itself serves.
		//
		// `/en` and `/en/` are one site to us, so we request whichever the config
		// happened to list and let the redirect carry us to the real one. That is
		// the page actually measured, and this is how you can tell which it was —
		// otherwise the redirect would be invisible, having been deliberately
		// suppressed as a non-move.
		canonicalUrl,
		// Age of the last attempt vs age of the data actually being displayed.
		ageHours,
		dataAgeHours,
		stale: ageHours === null || ageHours >= staleAfterHours,
		// Age of the figures actually on screen. Differs from  when the
		// newest attempt failed and the displayed numbers are older than it.
		dataStale: dataAgeHours === null || dataAgeHours >= staleAfterHours,
		neverMeasured: lastAt === null,
		trends,
		fieldHistory,
		labVsField: latest ? labVsField(latest, "lcp") : null,
		environmentDrift: environmentDrift(history),
		cwv,

		// Full axe results for the newest successful measurement.
		axe: latest?.axe ?? null,
		// What built the site and who serves it, detected on the same page load.
		//
		// Both are re-derived from what the record stored raw rather than read
		// back as detected, so a new rule (a CDN that stamps its PoP into
		// `server`, a generator we hadn't learned yet) applies to history already
		// on disk instead of only to future runs. Only the meta string is stored,
		// so a detection that came from a DOM mark is kept as it was found.
		generator: reDetectGenerator(latest?.axe?.generator),
		host: latest?.axe?.headers ? detectHost(latest.axe.headers) : (latest?.axe?.host ?? null),

		// The ranking inputs, in the order the leaderboard applies them, so the
		// site can explain why a row sits where it does.
		lighthouseTotal: lighthouseSum({ latest }),
		// Null, never undefined: JSON.stringify drops undefined keys entirely,
		// which would leave the report silently missing a documented field.
		cwvFailures: coreWebVitalFailures({ cwv }) ?? null,
		axeViolations: accessibilityViolations({ latest }),
		tiebreaker: round(tiebreakerValue({ latest }), 0),
		tiebreakerWeight: tiebreakerWeight({ latest }),
	};
}

/**
 * Trim a trend for serialization.
 *
 * `trend()` returns a point per measurement as `{date, timestamp, value}`, and
 * a site has ~26 trends. Serializing that duplicates the entire history 26
 * times — at 120 points per site it is roughly 190 kB per site, which the
 * in-memory version got away with and a JSON artifact does not.
 *
 * Sparklines only ever plot the values, so that is all we keep. The dates are
 * still available on `history`, which is the same series.
 */
function slimTrend(t, metric) {
	return {
		key: t.key,
		// Kept for the sparkline's accessible label. `unit` and `note` are not:
		// they are identical for every site and are emitted once under
		// report.metrics instead of ~26 times per site.
		label: metric.label,
		values: t.points.map((p) => p.value),
		current: t.current,
		previous: t.previous,
		first: t.first,
		min: t.min,
		max: t.max,
		count: t.count,
		vsPrevious: slimDelta(t.vsPrevious),
		sinceFirst: slimDelta(t.sinceFirst),
		lowerIsBetter: t.lowerIsBetter,
		significant: isSignificant(t),
	};
}

/** A delta's `current`/`previous` restate the trend they hang off. */
function slimDelta(d) {
	if (!d) return null;
	return { change: d.change, pct: d.pct, better: d.better, unchanged: d.unchanged };
}

/**
 * Stitch several URLs' series into one chronological history.
 *
 * Each point is tagged with the URL it was measured at, so the report can show
 * where a site changed address rather than letting the step-change look like a
 * performance regression.
 */
function mergeSeries(store, urls) {
	if (urls.length === 1) {
		return store.series(urls[0]).map((p) => ({ ...p, via: urls[0] }));
	}

	const merged = [];
	for (let url of urls) {
		for (let point of store.series(url)) merged.push({ ...point, via: url });
	}

	return merged.sort((a, b) => a.timestamp - b.timestamp);
}

/** Newest successful record across a move chain, current URL first. */
function latestSuccessAcross(store, urls) {
	for (let i = urls.length - 1; i >= 0; i--) {
		const record = store.latestSuccess(urls[i]);
		if (record) return record;
	}
	return null;
}

/** The first point measured at the current URL — where the move happened. */
function findMoveBoundary(series) {
	const last = series[series.length - 1]?.via;
	if (!last) return null;

	const first = series.find((p) => p.via === last);
	return first ? first.date : null;
}

/**
 * Core Web Vitals pass/fail.
 *
 * Field data is authoritative — it is the measurement Google actually uses.
 * Stored field data always renders, even if the key is absent from this
 * particular build, because throwing away data we already collected would be
 * worse than a stale label.
 *
 * The lab approximation is only offered when CrUX is configured but this URL
 * lacks coverage (too little Chrome traffic). With no key at all, Core Web
 * Vitals are skipped outright rather than approximated.
 */
function coreWebVitals(latest, cruxEnabled, fieldHistory) {
	if (!latest) return null;

	// 1. Field data captured alongside the measurement itself — freshest.
	if (latest.field?.metrics) {
		return fromField(latest.field.metrics, "field", {
			first: latest.field.collectionPeriod?.first,
			last: latest.field.collectionPeriod?.last,
			scope: latest.field.scope,
		});
	}

	// 2. The newest week of backfilled history. Same measurement, same shape,
	//    fetched by `speedlify backfill` rather than during a run — so a site that
	//    was measured before the API key existed still gets a real assessment
	//    instead of falling through to the approximation below.
	const weeks = fieldHistory?.series;
	const newest = weeks?.length ? weeks[weeks.length - 1] : null;
	if (newest?.metrics) {
		return fromField(newest.metrics, "field-history", {
			first: newest.period?.first,
			last: newest.date,
			scope: fieldHistory.scope,
		});
	}

	// 3. Only now fall back to approximating from lab timings.
	if (!cruxEnabled) return null;

	const t = latest.lab?.timings;
	if (!t) return null;

	// Lab has no INP, so this is a two-of-three approximation. Labelled as such
	// in the UI so it is never mistaken for the real assessment.
	const parts = [
		{ key: "lcp", value: t.lcp, rating: band(t.lcp, 2500, 4000) },
		{ key: "cls", value: t.cls, rating: band(t.cls, 0.1, 0.25) },
		{ key: "tbt", value: t.tbt, rating: band(t.tbt, 200, 600), proxyFor: "inp" },
	];

	return {
		source: "lab",
		parts,
		pass: parts.every((p) => p.rating === "good"),
		assessed: parts.length,
	};
}

/** Shape a real CrUX metrics object into a Core Web Vitals assessment. */
function fromField(metrics, source, period) {
	const parts = ["lcp", "inp", "cls"].map((k) => ({
		key: k,
		value: metrics[k]?.p75 ?? null,
		rating: metrics[k]?.rating ?? null,
		distribution: metrics[k]?.distribution ?? null,
	}));

	const rated = parts.filter((p) => p.rating);

	return {
		source,
		period: period || null,
		parts,
		// Null rather than false when nothing was rated — "no data" and "fails"
		// are different claims.
		pass: rated.length ? rated.every((p) => p.rating === "good") : null,
		assessed: rated.length,
	};
}

function band(v, good, poor) {
	if (typeof v !== "number") return null;
	if (v <= good) return "good";
	if (v <= poor) return "needs-improvement";
	return "poor";
}

function readFieldHistory(resultsDir, hash) {
	const file = path.join(resultsDir, hash, "field-history.json");
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Attach ranks for each headline metric under `field`, so the same entry can
 * carry both its global and its within-group position.
 */
function rankEntries(entries, field, compare) {
	const withValues = entries.filter((e) => e.latest);

	const rankings = {
		performance: rank(withValues, (e) => e.latest.lab?.scores?.performance),
		accessibility: rank(withValues, (e) => e.latest.lab?.scores?.accessibility),
		lcp: rank(withValues, (e) => e.latest.lab?.timings?.lcp, { lowerBetter: true }),
		weight: rank(withValues, (e) => e.latest.lab?.weight?.total, { lowerBetter: true }),
		requests: rank(withValues, (e) => e.latest.lab?.weight?.requests, { lowerBetter: true }),
	};

	// The leaderboard rank: total Lighthouse score, then axe violations, then
	// Speed Index per KB. This is the one the # column shows.
	for (let { entry, rank: position } of rankLeaderboard(withValues, compare)) {
		assignRank(entry, field, "overall", position);
	}

	for (let [metric, ranked] of Object.entries(rankings)) {
		for (let { entry, rank: position } of ranked) {
			assignRank(entry, field, metric, position);
		}
	}

	return entries;
}

/**
 * Row order is the leaderboard order, so the position of a row and the rank
 * printed on it can never disagree.
 */
function sortByLeaderboard(entries, compare) {
	return [...entries].sort(compare);
}

function findOrphans(entries, store, resultsDir) {
	// Both the configured URLs and every predecessor whose history is now
	// stitched into one of them.
	const known = new Set();
	for (let entry of entries) {
		known.add(entry.hash);
		for (let previous of entry.previousUrls) known.add(urlHash(previous));
	}

	return store
		.hashes()
		.filter((h) => !known.has(h))
		.map((hash) => {
			const metaFile = path.join(resultsDir, hash, "meta.json");
			if (!fs.existsSync(metaFile)) return { hash, url: null, name: hash };
			try {
				return { hash, ...JSON.parse(fs.readFileSync(metaFile, "utf8")) };
			} catch {
				return { hash, url: null, name: hash };
			}
		});
}

/**
 * Coverage — how complete and how current the picture is.
 *
 * With rolling measurement the report is always a snapshot of an uneven
 * dataset: some sites measured minutes ago, some days ago, some never. Stating
 * that plainly is the difference between a dashboard you can trust and one
 * that quietly implies everything was measured together.
 */
function buildCoverage(entries, config) {
	const ages = entries.map((e) => e.ageHours).filter((n) => typeof n === "number");
	ages.sort((a, b) => a - b);

	return {
		total: entries.length,
		measured: entries.filter((e) => !e.neverMeasured).length,
		never: entries.filter((e) => e.neverMeasured).length,
		stale: entries.filter((e) => e.stale && !e.neverMeasured).length,
		failing: entries.filter((e) => e.currentlyFailing).length,
		staleAfterHours: config.staleAfterHours,
		// Median beats mean here: one site stuck at 400h shouldn't characterise
		// the other 999.
		medianAgeHours: ages.length ? round(ages[Math.floor(ages.length / 2)], 1) : null,
		oldestAgeHours: ages.length ? round(ages[ages.length - 1], 1) : null,
		newestAgeHours: ages.length ? round(ages[0], 1) : null,
	};
}

function round(v, places) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

/**
 * Re-run generator detection over what a stored record kept.
 *
 * Records keep the raw `meta[name=generator]` string alongside the detection,
 * so a rule added after the fact can be applied to data already on disk. A
 * detection that came from a DOM mark has nothing raw to re-read, and is passed
 * through untouched.
 */
function reDetectGenerator(stored) {
	if (!stored) return null;
	if (!stored.raw) return stored;
	return detectGenerator({ meta: stored.raw }) ?? stored;
}

/**
 * Tally detected generators and hosts across every measured site.
 *
 * Counted from the newest successful measurement of each, so a site is one
 * vote regardless of how many times it has been measured or how many
 * categories it appears in. `unknown` is the sites measured but with nothing
 * detected — kept visible so the percentages are honest about their base.
 */
function buildStacks(entries) {
	const tally = (pick, iconOf) => {
		const counts = new Map();
		let unknown = 0;

		for (let entry of entries) {
			if (!entry.latest) continue;

			const detected = pick(entry);
			if (!detected?.name) {
				unknown++;
				continue;
			}

			const existing = counts.get(detected.name);
			if (existing) existing.count++;
			else counts.set(detected.name, { name: detected.name, icon: iconOf(detected), count: 1 });
		}

		const all = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
		const detectedTotal = all.reduce((sum, i) => sum + i.count, 0);

		// One site running something nobody else runs, with no brand mark to
		// recognise it by, is a row of noise in a summary — `build.lua`, `blag`
		// and `x-log` are one person's own generator. Two sites is a pattern and
		// earns its row. They stay in `detected` either way: they were detected,
		// and the totals have to keep adding up.
		const items = all.filter((i) => i.icon || i.count > 1);
		const rare = all.filter((i) => !i.icon && i.count === 1);

		return {
			items,
			// What the list is not showing, so the page can say so rather than
			// quietly disagreeing with its own count.
			rare: rare.length,
			rareNames: rare.map((i) => i.name),
			detected: detectedTotal,
			unknown,
			distinct: all.length,
		};
	};

	return {
		generators: tally((e) => e.generator, (d) => d.icon ?? null),
		hosts: tally((e) => e.host, (d) => d.icon ?? null),
	};
}

/**
 * Full marks in every Lighthouse category.
 *
 * Derived rather than hardcoded to 400, so adding or removing a category cannot
 * leave this quietly counting a bar nothing can reach.
 */
const PERFECT_TOTAL = SCORES.length * 100;

/** Eleventy under either name — the project is mid-rename to Build Awesome. */
const ELEVENTY_IDS = new Set(["eleventy", "build-awesome"]);

/**
 * Average page weight per day, across everything measured that day.
 *
 * Withheld until there are `MIN_WEIGHT_HISTORY_DAYS` of them. A handful of days
 * is not a trend: the fleet is measured on a rolling schedule, so each day's
 * average is drawn from whichever slice happened to come up, and over a short
 * window that composition moves the line far more than the sites do. Given
 * enough days the sampling evens out and the shape means something.
 */
const MIN_WEIGHT_HISTORY_DAYS = 14;

function buildWeightHistory(weightByDay) {
	const days = Object.keys(weightByDay).sort();
	if (days.length < MIN_WEIGHT_HISTORY_DAYS) return [];

	return days.map((date) => {
		const values = weightByDay[date];
		return {
			date,
			avgWeight: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
			sites: values.length,
		};
	});
}

function buildStats(entries) {
	const measured = entries.filter((e) => e.latest);
	const scores = measured.map((e) => e.latest.lab?.scores?.performance).filter((n) => typeof n === "number");
	const weights = measured.map((e) => e.latest.lab?.weight?.total).filter((n) => typeof n === "number");

	const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

	return {
		total: entries.length,
		measured: measured.length,
		failing: entries.filter((e) => e.currentlyFailing).length,
		// All four Lighthouse categories at 100 — what Speedlify calls a "hundo".
		// Counting only the performance score here would call a site perfect
		// while it was failing accessibility, and would disagree with the Total
		// column the leaderboard is ranked by.
		perfect: measured.filter((e) => e.lighthouseTotal === PERFECT_TOTAL).length,
		// How many of those perfect scores are Eleventy, under either name.
		// Counts a mark presumed from a curated list alongside a detected one:
		// most static sites emit no generator tag, so detections alone would
		// undercount the thing this number exists to measure.
		perfectEleventy: measured.filter(
			(e) =>
				e.lighthouseTotal === PERFECT_TOTAL &&
				ELEVENTY_IDS.has(e.generator?.id ?? e.presumedGenerator?.id),
		).length,
		// The marks to show beside that number, resolved from the generator list
		// rather than named again in a template — two places to edit is how a
		// rename ends up half-applied.
		perfectEleventyMarks: [...ELEVENTY_IDS].map(generatorById).filter(Boolean),
		// Sites at 100 in at least one category, which is a much easier bar and
		// is not what "perfect" means.
		anyHundred: measured.filter((e) => {
			const s = e.latest.lab?.scores || {};
			return [s.performance, s.accessibility, s["best-practices"], s.seo].some((v) => v === 100);
		}).length,
		avgTotal: avg(measured.map((e) => e.lighthouseTotal).filter((n) => typeof n === "number")),
		avgPerformance: avg(scores),
		avgWeight: avg(weights),
		totalMeasurements: entries.reduce((sum, e) => sum + e.historyCount, 0),
		cwvPassing: measured.filter((e) => e.cwv?.pass).length,
		// Denominator for the pass count: only sites that actually have an
		// assessment, not every measured site.
		cwvAssessed: measured.filter((e) => e.cwv).length,
	};
}

/**
 * Store a rank under `ranks` or `groupRanks[groupId]`.
 *
 * The field name carries the scope: "ranks" for the global pass, and
 * "groupRanks:ssg" for a group. A site in several categories needs a rank in
 * each, so those are nested rather than sharing one key — writing them flat
 * would have the last group silently overwrite the others, which is exactly
 * the bug that made a site show its global position inside a group table.
 */
function assignRank(entry, field, metric, position) {
	const [scope, groupId] = field.split(":");

	if (!groupId) {
		entry[scope] = entry[scope] || {};
		entry[scope][metric] = position;
		return;
	}

	entry[scope] = entry[scope] || {};
	entry[scope][groupId] = entry[scope][groupId] || {};
	entry[scope][groupId][metric] = position;
}
