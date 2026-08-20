#!/usr/bin/env node
// Must stay first: loads .env before anything reads process.env.
import "../lib/env.js";

import fs from "node:fs";
import v8 from "node:v8";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, selectSites } from "../lib/config.js";
import { ResultStore } from "../lib/store.js";
import { RunLogger, readRunHistory } from "../lib/log.js";
import { Runner } from "../lib/runner.js";
import { fetchFieldHistory, checkApiKey } from "../lib/crux.js";
import { stamp, urlHash } from "../lib/hash.js";
import { selectBatch, parseShard, nextFailureCount } from "../lib/schedule.js";
import { learnAliases, readAliases, applyAliases } from "../lib/aliases.js";
import { confirmRedirect } from "../lib/redirect.js";
import { buildReport } from "../lib/report.js";

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";

/**
 * Stop a measure run when the heap gets this close to V8's ceiling.
 *
 * Not a guess at a byte count: it is read from the running process, so it holds
 * whether or not someone has raised --max-old-space-size.
 */
const HEAP_STOP_FRACTION = 0.8;

function heapPressure() {
	return process.memoryUsage().heapUsed / v8.getHeapStatistics().heap_size_limit;
}
const LOGS_DIR = process.env.SPEEDLIFY_LOGS_DIR || "logs";
const REPORT_FILE = process.env.SPEEDLIFY_REPORT_FILE || "report.json";

const HELP = `
speedlify — measure web performance across sites and compare over time

Usage:
  speedlify measure [options]     Measure a batch of the stalest sites
  speedlify report [--out=F]      Generate the static JSON report the site builds from
  speedlify backfill [options]    Seed ~25 weeks of CrUX field history in one pass
  speedlify check                 Verify the CrUX API key works
  speedlify list                  Show configured sites and their latest result
  speedlify runs [--limit=N]      Show recent measurement runs from the log
  speedlify redirects             Show detected redirects and confirmed site moves
  speedlify reindex               Rebuild series.json from the raw records
  speedlify prune [options]       Delete old result files

Options:
  --limit=<n>       Measure at most this many sites (default: config batchSize)
  --shard=<i/n>     Only this slice of the site list, e.g. 2/4
  --group=<id,id>   Only these config groups
  --url=<url>       Only this URL
  --filter=<text>   Only sites whose name or URL contains this
  --runs=<n>        Lighthouse runs per site (default: config value)
  --desktop         Measure desktop instead of mobile
  --force           Ignore the freshness window and re-measure everything
  --no-field        Skip CrUX field data
  --out=<file>      report: output path (default report.json)
  --pretty          report: indent the JSON for reading
  --stale           list: show only sites with no recent data
  --days=<n>        Prune: delete results older than this (default 365)
  --keep=<n>        Prune: always keep this many per site (default 30)
  --dry-run         Prune: report what would be deleted
  --quiet           Suppress console output (the log file is still written)

Environment:
  CRUX_API_KEY      Google API key with the Chrome UX Report API enabled.
                    Without it, field data and Core Web Vitals INP are skipped.
`;

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	strict: false,
	options: {
		group: { type: "string" },
		url: { type: "string" },
		filter: { type: "string" },
		runs: { type: "string" },
		limit: { type: "string" },
		days: { type: "string" },
		keep: { type: "string" },
		shard: { type: "string" },
		stale: { type: "boolean" },
		out: { type: "string" },
		pretty: { type: "boolean" },
		desktop: { type: "boolean" },
		force: { type: "boolean" },
		"no-field": { type: "boolean" },
		"dry-run": { type: "boolean" },
		quiet: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});

const command = positionals[0] || "help";

const commands = { measure, report, backfill, check, list, runs: runsCmd, redirects, reindex, prune, help: showHelp };

if (flags.help || !commands[command]) {
	showHelp();
	process.exit(commands[command] || flags.help ? 0 : 1);
}

try {
	await commands[command]();
} catch (err) {
	process.stderr.write(`\x1b[31mError:\x1b[0m ${err.message}\n`);
	if (process.env.DEBUG) process.stderr.write(err.stack + "\n");
	process.exit(1);
}

/* -------------------------------------------------------------------------- */

function showHelp() {
	process.stdout.write(HELP);
}

async function measure() {
	const config = await loadConfig();

	// Follow confirmed site moves automatically. A redirect that has proved
	// permanent and stable is measured at its destination without anyone
	// editing config/sites.js.
	const configuredSites = applyAliases(config.sites, readAliases(RESULTS_DIR).aliases, urlHash);
	const matched = selectSites(configuredSites, flags);

	if (!matched.length) {
		process.stdout.write("No sites matched.\n");
		return;
	}

	const runId = stamp();
	const logger = new RunLogger({ dir: LOGS_DIR, runId, quiet: flags.quiet });
	const store = new ResultStore(RESULTS_DIR);

	const formFactor = flags.desktop ? "desktop" : config.formFactor;
	const runsPer = numFlag(flags.runs, config.runs);
	const cruxApiKey = flags["no-field"] ? null : process.env.CRUX_API_KEY || null;
	const shard = parseShard(flags.shard);

	// The batch is the unit of work. Each invocation spends its budget on the
	// staleest sites and stops — no invocation needs to see the whole list, and
	// an interrupted run costs at most the sites it hadn't reached.
	const limit = numFlag(flags.limit, config.batchSize ?? null);
	const batch = selectBatch(matched, store, {
		limit,
		freshnessHours: flags.force ? 0 : config.freshnessHours,
		retryErrorsAfterHours: config.retryErrorsAfterHours,
		failureBackoff: config.failureBackoff,
		shard,
	});

	const sites = batch.selected;

	logger.info(`batch: ${sites.length} of ${batch.poolSize} site(s)`, {
		limit,
		eligible: batch.eligible,
		skippedFresh: batch.skipped.fresh,
		skippedBackoff: batch.skipped.backoff,
		caughtUp: batch.caughtUp,
		shard: shard ? `${shard.index + 1}/${shard.total}` : null,
		formFactor,
		runsPer,
		field: Boolean(cruxApiKey),
		// Politeness settings in play for this batch, if any.
		rateLimited: [...new Set(sites.map((s) => s.rateLimit?.delayMs).filter(Boolean))],
	});

	if (!sites.length) {
		const why = batch.skipped.fresh
			? `all ${batch.skipped.fresh} site(s) measured within the last ${config.freshnessHours}h`
			: "nothing eligible";
		logger.info(`nothing to measure — ${why}`);
		await logger.close({ ...summaryOf(batch), measured: 0, skipped: batch.skipped.fresh, failed: 0, formFactor });
		if (!flags.quiet) process.stdout.write(`\n  Nothing to measure: ${why}.\n\n`);
		return;
	}

	if (!cruxApiKey && !flags["no-field"]) {
		logger.warn("CRUX_API_KEY not set — lab data only, no field metrics or INP");
	}

	const runner = new Runner({ logger, runs: runsPer, formFactor, cruxApiKey });
	const summary = {
		...summaryOf(batch),
		measured: 0,
		skipped: batch.skipped.fresh,
		failed: 0,
		formFactor,
	};

	try {
		await runner.launch();

		for (let [i, site] of sites.entries()) {
			const prefix = `[${i + 1}/${sites.length}]`;
			const age = batch.detail[i]?.ageHours;

			logger.info(
				`${prefix} ${site.name}${age === Infinity ? " (never measured)" : age ? ` (${age.toFixed(1)}h old)` : ""}`,
				{ url: site.url }
			);

			const record = await runner.measure(site);

			// Carry the consecutive-failure count forward so the next scheduler
			// run can back off without re-reading this site's history.
			const previous = store.latest(site.url);
			record.consecutiveFailures = nextFailureCount(previous, Boolean(record.error));

			const file = store.write(record);

			const redirect = record.lab?.redirect;
			if (redirect) {
				logger.warn(`${prefix} ${site.name} redirects to ${redirect.to}`, {
					from: redirect.from,
					to: redirect.to,
					change: redirect.change,
					permanent: redirect.permanent,
					statuses: redirect.statuses,
				});
			}

			if (record.error) {
				summary.failed++;
				logger.error(`${prefix} ${site.name} FAILED`, { error: record.error });
			} else {
				summary.measured++;
				const s = record.lab.scores;
				const t = record.lab.timings;
				logger.info(
					`${prefix} ${site.name} — perf ${s.performance} a11y ${s.accessibility} ` +
						`bp ${s["best-practices"]} seo ${s.seo} | LCP ${fmtMs(t.lcp)} CLS ${t.cls} TBT ${fmtMs(t.tbt)}`,
					{ file }
				);
			}

			// Lighthouse does not give all of its memory back. A few thousand runs
			// in one process is enough to exhaust the heap, and the crash costs the
			// alias-learning and summary work below even though every record up to
			// that point is already on disk.
			//
			// Stopping early is cheap here precisely because measurement is rolling:
			// an invocation that does part of its batch is a successful invocation,
			// and the next one picks up whatever is stalest — including whatever
			// this run did not reach.
			if (heapPressure() >= HEAP_STOP_FRACTION) {
				summary.stoppedEarly = { after: summary.measured + summary.failed, remaining: sites.length - (i + 1) };
				logger.warn(
					`stopping after ${summary.stoppedEarly.after} site(s): heap is ${Math.round(heapPressure() * 100)}% of its limit`,
					{ remaining: summary.stoppedEarly.remaining, advice: "lower batchSize to keep each run short" },
				);
				break;
			}
		}
	} finally {
		await runner.close();
	}

	// Promote any redirect that has now held steady long enough to count as a
	// real move. Runs over every configured site, not just this batch, so an
	// alias is confirmed as soon as the evidence exists regardless of which
	// shard happened to collect it.
	const { learned } = learnAliases(store, matched.map((s) => s.url), {
		resultsDir: RESULTS_DIR,
		confirmations: config.redirectConfirmations,
	});

	summary.aliasesLearned = learned.length;
	for (let alias of learned) {
		logger.warn(`confirmed move: ${alias.from} -> ${alias.to}`, alias);
	}

	const record = await logger.close(summary);
	if (!flags.quiet) {
		// A run that stopped early left its untouched sites eligible too.
		const remaining =
			Math.max(0, batch.eligible - sites.length) + (summary.stoppedEarly?.remaining ?? 0);
		process.stdout.write(
			`\n  ${summary.measured} measured · ${summary.skipped} fresh · ${summary.failed} failed` +
				`  (${(record.durationMs / 1000).toFixed(1)}s)\n` +
				(summary.stoppedEarly
					? `  ! stopped early under memory pressure after ${summary.stoppedEarly.after} site(s)\n` +
						`    Lighthouse does not fully release memory between runs, so a very long\n` +
						`    invocation exhausts the heap. Lower batchSize and run more often.\n`
					: "") +
				(remaining
					? `  ${remaining} site(s) still stale — run again to continue\n`
					: `  coverage caught up\n`) +
				`  log: ${record.logFile}\n\n`
		);
	}

	if (summary.failed && summary.measured === 0) process.exit(1);
}

function summaryOf(batch) {
	return {
		batchSize: batch.selected.length,
		poolSize: batch.poolSize,
		eligible: batch.eligible,
		backoff: batch.skipped.backoff,
		caughtUp: batch.caughtUp,
	};
}

/**
 * Seed field history. The CrUX History API hands back ~25 weekly data points
 * per call, so a fresh install gets six months of real-user trend immediately
 * instead of waiting six months to grow one.
 */
async function backfill() {
	const apiKey = process.env.CRUX_API_KEY;
	if (!apiKey) throw new Error("CRUX_API_KEY is required for backfill");

	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const runId = `backfill-${stamp()}`;
	const logger = new RunLogger({ dir: LOGS_DIR, runId, quiet: flags.quiet });

	const formFactor = flags.desktop ? "DESKTOP" : "PHONE";
	const summary = { sites: sites.length, written: 0, missing: 0, failed: 0 };

	for (let [i, site] of sites.entries()) {
		const prefix = `[${i + 1}/${sites.length}]`;
		try {
			const history = await fetchFieldHistory(site.url, { apiKey, formFactor });

			if (!history) {
				logger.warn(`${prefix} no field data ${site.name}`, { url: site.url });
				summary.missing++;
				continue;
			}

			const dir = path.join(RESULTS_DIR, site.hash);
			fs.mkdirSync(dir, { recursive: true });

			const payload = {
				url: site.url,
				name: site.name,
				group: site.group,
				fetchedAt: new Date().toISOString(),
				...history,
			};
			fs.writeFileSync(path.join(dir, "field-history.json"), JSON.stringify(payload, null, 2) + "\n");

			logger.info(`${prefix} ${site.name} — ${history.series.length} weeks (${history.scope})`);
			summary.written++;
		} catch (err) {
			logger.error(`${prefix} ${site.name} failed`, { error: err.message });
			summary.failed++;
		}
	}

	await logger.close(summary);
	if (!flags.quiet) {
		process.stdout.write(
			`\n  ${summary.written} backfilled · ${summary.missing} without field data · ${summary.failed} failed\n\n`
		);
	}
}

async function check() {
	const apiKey = process.env.CRUX_API_KEY;
	if (!apiKey) {
		process.stdout.write(
			"\n  CRUX_API_KEY is not set.\n\n" +
				"  Field data (and INP, which Lighthouse cannot measure in a lab run) will be\n" +
				"  skipped. To enable it:\n\n" +
				"    1. Create an API key at https://console.cloud.google.com/apis/credentials\n" +
				"    2. Enable the Chrome UX Report API for that project\n" +
				"    3. Put it in a .env file (see .env.example) or export it:\n\n" +
				"         echo 'CRUX_API_KEY=your-key' >> .env\n" +
				"         export CRUX_API_KEY=your-key\n\n"
		);
		process.exit(1);
	}

	process.stdout.write("  Checking CrUX API key against https://web.dev …\n");
	const result = await checkApiKey(apiKey);

	if (!result) {
		process.stdout.write("  Key works, but the test origin returned no data.\n");
		return;
	}

	process.stdout.write(`  OK — ${result.collectionPeriod.first} to ${result.collectionPeriod.last}\n\n`);
	for (let [name, m] of Object.entries(result.metrics)) {
		process.stdout.write(
			`    ${name.toUpperCase().padEnd(5)} p75 ${String(m.p75).padStart(8)}  ${m.rating ?? ""}\n`
		);
	}
	process.stdout.write("\n");
}

async function list() {
	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const store = new ResultStore(RESULTS_DIR);

	const now = Date.now();

	let rows = sites.map((site) => {
		// Newest successful data, which may be older than the newest attempt.
		const latest = store.latestSuccess(site.url);
		const lastAt = store.lastMeasuredAt(site.url);
		const ageHours = lastAt === null ? Infinity : (now - lastAt) / 3600000;

		return {
			name: site.name,
			group: site.group,
			perf: latest?.lab?.scores?.performance ?? null,
			lcp: latest?.lab?.timings?.lcp ?? null,
			field: latest?.field?.metrics?.lcp?.p75 ?? null,
			runs: store.count(site.url),
			ageHours,
			stale: ageHours >= (site.staleAfterHours ?? config.staleAfterHours ?? 48),
			never: lastAt === null,
		};
	});

	// Stalest first — the same order the scheduler will pick them in.
	rows.sort((a, b) => b.ageHours - a.ageHours);
	if (flags.stale) rows = rows.filter((r) => r.stale);

	const w = Math.max(4, ...rows.map((r) => r.name.length));
	process.stdout.write(
		`\n  ${"SITE".padEnd(w)}  ${"GROUP".padEnd(10)} ${"PERF".padStart(5)} ${"LAB LCP".padStart(9)} ${"FIELD LCP".padStart(10)} ${"RUNS".padStart(5)}  AGE\n`
	);
	process.stdout.write(`  ${"─".repeat(w + 52)}\n`);

	for (let r of rows) {
		const age = r.never ? "never" : r.ageHours < 48 ? `${r.ageHours.toFixed(1)}h` : `${(r.ageHours / 24).toFixed(1)}d`;
		const mark = r.never ? " ✗" : r.stale ? " !" : "";
		process.stdout.write(
			`  ${r.name.padEnd(w)}  ${r.group.slice(0, 10).padEnd(10)} ` +
				`${String(r.perf ?? "—").padStart(5)} ${fmtMs(r.lcp).padStart(9)} ${fmtMs(r.field).padStart(10)} ` +
				`${String(r.runs).padStart(5)}  ${age}${mark}\n`
		);
	}

	const stale = rows.filter((r) => r.stale).length;
	// Each row was judged against its own category's threshold; the summary can
	// only name one, so it names the default and says so when they differ.
	const thresholds = new Set(sites.map((s) => s.staleAfterHours ?? config.staleAfterHours ?? 48));
	const staleLabel =
		thresholds.size > 1
			? `each category's own threshold`
			: `older than ${[...thresholds][0]}h`;
	process.stdout.write(
		`\n  ${rows.length} site(s) · ${stale} stale (${staleLabel}) · ` +
			`${rows.filter((r) => r.never).length} never measured\n\n`
	);
}

async function runsCmd() {
	const history = readRunHistory(LOGS_DIR, numFlag(flags.limit, 20));

	if (!history.length) {
		process.stdout.write("\n  No runs logged yet.\n\n");
		return;
	}

	process.stdout.write(`\n  ${"RUN".padEnd(26)} ${"DUR".padStart(7)} ${"OK".padStart(4)} ${"SKIP".padStart(5)} ${"FAIL".padStart(5)}  LOG\n`);
	process.stdout.write(`  ${"─".repeat(78)}\n`);

	for (let r of history) {
		process.stdout.write(
			`  ${r.startedAt.slice(0, 19).replace("T", " ").padEnd(26)} ` +
				`${((r.durationMs || 0) / 1000).toFixed(0).padStart(6)}s ` +
				`${String(r.measured ?? r.written ?? 0).padStart(4)} ${String(r.skipped ?? 0).padStart(5)} ${String(r.failed ?? 0).padStart(5)}  ${r.logFile || ""}\n`
		);
	}
	process.stdout.write("\n");
}

/**
 * Generate the static JSON report the site is built from.
 *
 * This is the analysis step: it reads the measurements, computes every trend,
 * ranking and comparison, and writes the result to a single file. The Build Awesome
 * build then renders that file and nothing else — it never opens a measurement,
 * so it works against a read-only checkout and cannot mutate any cache as a
 * side effect.
 */
async function report() {
	const out = flags.out || REPORT_FILE;
	const started = Date.now();

	const data = await buildReport({ resultsDir: RESULTS_DIR });

	const json = flags.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, json + "\n");

	const bytes = Buffer.byteLength(json);
	const size = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	const c = data.coverage;

	process.stdout.write(
		`\n  wrote ${out}  ${size}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n` +
			`  ${data.entries.length} sites · ${c.measured} with data · ${c.stale} stale · ${c.never} never measured\n` +
			(data.moving.length ? `  ${data.moving.length} site(s) redirecting elsewhere — see \`speedlify redirects\`\n` : "") +
			(data.orphans.length ? `  ${data.orphans.length} orphaned histor${data.orphans.length === 1 ? "y" : "ies"}\n` : "") +
			// Loud on purpose: a collision silently costs those sites their embed.
			data.slugCollisions
				.map((c) => `  ! slug collision on "${c.slug}" — using hashes for ${c.urls.join(", ")}\n`)
				.join("") +
			"\n"
	);
}

/**
 * Show detected redirects and confirmed moves.
 *
 * Answers the two questions a redirect raises: is this site moving, and has
 * speedlify already carried its history across?
 */
async function redirects() {
	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const store = new ResultStore(RESULTS_DIR);

	const { aliases } = readAliases(RESULTS_DIR);
	const configured = new Set(config.sites.map((s) => s.url));

	const observed = [];
	for (let site of sites) {
		const points = store.series(site.url, { rebuild: false });
		const latest = points[points.length - 1];
		if (!latest?.to) continue;

		const verdict = confirmRedirect(points, { confirmations: config.redirectConfirmations });
		observed.push({ site, to: latest.to, permanent: latest.perm === 1, verdict });
	}

	if (!observed.length && !aliases.length) {
		process.stdout.write("\n  No redirects detected.\n\n");
		return;
	}

	if (observed.length) {
		process.stdout.write("\n  Currently redirecting\n  ─────────────────────\n");
		for (let o of observed) {
			const state = o.verdict.confirmed
				? "confirmed move"
				: `not yet confirmed (${o.verdict.reason}, ${o.verdict.observations}/${config.redirectConfirmations})`;
			process.stdout.write(
				`  ${o.site.name}\n    ${o.site.url}\n    → ${o.to}\n` +
					`    ${o.permanent ? "permanent" : "TEMPORARY — will not be aliased"} · ${state}\n\n`
			);
		}
	}

	if (aliases.length) {
		process.stdout.write("  Confirmed moves (history is merged)\n  ───────────────────────────────────\n");
		for (let a of aliases) {
			process.stdout.write(`  ${a.from}\n    → ${a.to}   [${a.source}, since ${(a.since || a.confirmedAt).slice(0, 10)}]\n`);
		}
		process.stdout.write("\n");
	}

	// A destination nobody is measuring means the config is now pointing at the
	// old address. History is safe either way, but the config should catch up.
	const dangling = observed.filter((o) => o.verdict.confirmed && !configured.has(o.to));
	if (dangling.length) {
		process.stdout.write("  Update config/sites.js\n  ──────────────────────\n");
		process.stdout.write("  These sites have moved. Point them at the new URL — history follows\n");
		process.stdout.write("  automatically via the confirmed alias, so no previousUrls is needed:\n\n");
		for (let o of dangling) {
			process.stdout.write(`    { name: ${JSON.stringify(o.site.name)}, url: ${JSON.stringify(o.to)} },\n`);
		}
		process.stdout.write("\n");
	}
}

/**
 * Rebuild every series.json from the raw records.
 *
 * The series is a derived cache, so this is always safe to run: it never reads
 * anything but the archive, and never writes anything but the cache. Needed
 * after changing the projection in lib/series.js, or after restoring results
 * from a backup.
 */
async function reindex() {
	const store = new ResultStore(RESULTS_DIR);
	const hashes = store.hashes();

	let rebuilt = 0;
	let empty = 0;
	let points = 0;
	const started = Date.now();

	for (let hash of hashes) {
		// Work from the stored meta rather than config, so histories for URLs
		// that have since been removed are reindexed too.
		const metaFile = path.join(RESULTS_DIR, hash, "meta.json");
		if (!fs.existsSync(metaFile)) {
			empty++;
			continue;
		}

		let url;
		try {
			url = JSON.parse(fs.readFileSync(metaFile, "utf8")).url;
		} catch {
			empty++;
			continue;
		}
		if (!url) {
			empty++;
			continue;
		}

		const series = store.rebuildSeries(url);
		if (series) {
			rebuilt++;
			points += series.points.length;
		} else {
			empty++;
		}
	}

	process.stdout.write(
		`\n  rebuilt ${rebuilt} series (${points.toLocaleString()} points)` +
			`${empty ? ` · ${empty} skipped` : ""}` +
			`  (${((Date.now() - started) / 1000).toFixed(1)}s)\n\n`
	);
}

async function prune() {
	const store = new ResultStore(RESULTS_DIR);
	const removed = store.prune({
		days: numFlag(flags.days, 365),
		keepMin: numFlag(flags.keep, 30),
		dryRun: Boolean(flags["dry-run"]),
	});

	const verb = flags["dry-run"] ? "would delete" : "deleted";
	process.stdout.write(`\n  ${verb} ${removed.length} result file(s)\n\n`);
}

/* -------------------------------------------------------------------------- */

/**
 * Numeric flag with a default. Not `Number(x) || fallback` — that silently
 * turns a deliberate `--days=0` into 365, which is the difference between
 * "prune everything" and "prune nothing".
 */
function numFlag(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function fmtMs(v) {
	if (v === null || v === undefined) return "—";
	return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}
