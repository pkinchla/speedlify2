import { isRetiredDestination } from "./redirect.js";

/**
 * Which sites should this run measure?
 *
 * Measurement is a rolling process, not a sweep. Each invocation takes a budget
 * (`limit`) and spends it on the sites whose data is most out of date, so the
 * fleet converges toward evenly-fresh coverage no matter how often you run,
 * how many machines you run on, or how many runs get killed halfway through.
 *
 * Nothing here coordinates between processes and nothing needs a complete pass
 * to be useful — a run that measures 20 of 1000 sites is a successful run.
 */

const HOUR = 60 * 60 * 1000;

/**
 * How long to wait before retrying a site that failed, by consecutive failure
 * count. A URL that has been dead for a week shouldn't consume a slot in every
 * batch ahead of 900 sites with real data.
 */
export function backoffHours(consecutiveFailures) {
	if (!consecutiveFailures) return 0;
	// 1h, 2h, 4h, 8h, 16h, capped at ~24h so a recovered site is picked up
	// within a day rather than being forgotten.
	return Math.min(2 ** (consecutiveFailures - 1), 24);
}

/**
 * Rank every site by how badly it needs measuring, then take `limit`.
 *
 * Priority, in order:
 *   1. never measured        — a site with no data at all is the worst case
 *   2. oldest measurement    — straight staleness
 *
 * Skipped entirely: anything measured within `freshnessHours`.
 *
 * A failed attempt is not data, so a failing site is never held by the
 * freshness window — without that, an error would buy the site a full
 * freshness period of silence, which on a weekly cadence means a transient
 * blip goes unretried for a week. Failures wait on `retryErrorsAfterHours`
 * instead, which defaults to 0: the very next run.
 */
export function selectBatch(sites, store, options = {}) {
	const {
		limit = null,
		freshnessHours = 0,
		now = Date.now(),
		shard = null, // { index, total }
		// How long a site whose last attempt errored waits before being tried
		// again. 0 — the default — means the very next run.
		retryErrorsAfterHours = 0,
		// Escalate that wait exponentially with each consecutive failure: 1h, 2,
		// 4, 8, 16, capped at 24. Worth turning on when a large number of
		// permanently-dead URLs starts costing every run a slot each.
		failureBackoff = false,
		// URLs to measure ahead of everything else, from the priority queue. They
		// skip the freshness and backoff gates and sort to the front of the batch
		// — the point of queueing one is that its normal turn is too far away.
		priority = null,
	} = options;

	const queued = priority instanceof Set ? priority : new Set(priority ?? []);

	const pool = shard ? partition(sites, shard) : sites;

	const candidates = pool.map((site) => {
		// Filename-derived, so this stays cheap across thousands of sites.
		const lastAt = store.lastMeasuredAt(site.url);

		let consecutiveFailures = 0;
		let failing = false;
		let retired = false;

		if (lastAt !== null) {
			// One file read, and only to check the failure state.
			const latest = store.latest(site.url);
			failing = Boolean(latest?.error);
			consecutiveFailures = failing ? latest.consecutiveFailures || 1 : 0;
			// The domain lapsed and a registrar is selling it. Measuring a parking
			// page costs a full Lighthouse run and tells us nothing about a site
			// that no longer exists.
			retired = isRetiredDestination(latest?.lab?.finalUrl);
		}

		const ageHours = lastAt === null ? Infinity : (now - lastAt) / HOUR;

		return { site, lastAt, ageHours, failing, consecutiveFailures, retired, priority: queued.has(site.url) };
	});

	const eligible = [];
	const skipped = { fresh: 0, backoff: 0, retired: 0, archived: 0 };

	for (let c of candidates) {
		// Archived by hand: the record is kept, the measuring stops. Ahead of the
		// freshness check for the same reason as a retired site — it is never due
		// again, and --force is about ignoring freshness, not about reviving
		// something deliberately taken out of circulation.
		//
		// Only the hand-written list, deliberately. A site archived automatically
		// for failing is still measured, on the backoff's daily cadence: that
		// archive is an observation rather than a decision, and a site that stops
		// being measured can never stop failing. Adding the failure count to this
		// check would make automatic archiving permanent.
		if (c.site.archived) {
			skipped.archived++;
			continue;
		}

		// Ahead of the freshness check: a retired site is never due again, and
		// --force is about ignoring freshness, not about resurrecting parked
		// domains. Removing the URL from the config is what un-retires it.
		if (c.retired) {
			skipped.retired++;
			continue;
		}

		// Queued by hand, so neither gate below applies. Deliberately *after* the
		// archived and retired checks rather than before: those are decisions
		// about whether a site should be measured at all, and this is a request
		// about when. Queueing an archived URL does not un-archive it.
		if (c.priority) {
			eligible.push(c);
			continue;
		}

		// A group may set its own cadence; `freshnessHours` here is the fallback.
		// A caller passing 0 — `--force` — overrides every site, since the point
		// of forcing is to ignore freshness entirely.
		const window = freshnessHours === 0 ? 0 : (c.site.freshnessHours ?? freshnessHours);
		// Freshness describes data. A site whose last attempt errored has none,
		// so it is eligible regardless of how recently that attempt happened.
		if (!c.failing && c.ageHours < window) {
			skipped.fresh++;
			continue;
		}
		if (c.failing) {
			// A flat floor, raised by the exponential curve when that is enabled —
			// so the two settings compose rather than contradicting each other.
			const floor = c.site.retryErrorsAfterHours ?? retryErrorsAfterHours;
			const wait = failureBackoff
				? Math.max(floor, backoffHours(c.consecutiveFailures))
				: floor;

			if (c.ageHours < wait) {
				skipped.backoff++;
				continue;
			}
		}
		eligible.push(c);
	}

	// Queued first, then never-measured (Infinity sorts to the front), then
	// oldest first.
	eligible.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority ? -1 : 1;
		if (a.ageHours !== b.ageHours) return b.ageHours - a.ageHours;
		// Stable tiebreak so repeated runs don't reshuffle equal candidates.
		return a.site.url.localeCompare(b.site.url);
	});

	const selected = limit === null ? eligible : eligible.slice(0, limit);

	return {
		selected: selected.map((c) => c.site),
		detail: selected,
		eligible: eligible.length,
		// Which queued URLs this shard actually took, so the caller knows what to
		// remove from the file. A queued URL in another shard's slice, or one cut
		// off by the batch limit, stays queued for next time.
		priority: selected.filter((c) => c.priority).map((c) => c.site.url),
		skipped,
		// Everything eligible fits in this batch: coverage is caught up.
		caughtUp: limit === null || eligible.length <= limit,
		poolSize: pool.length,
	};
}

/**
 * Deterministic partition for running several independent measure processes at
 * once. Each shard owns a disjoint slice, so two machines never spend their
 * budget on the same sites without needing any shared lock.
 */
export function partition(sites, { index, total }) {
	if (!Number.isInteger(total) || total < 1) throw new Error("shard total must be a positive integer");
	if (!Number.isInteger(index) || index < 0 || index >= total) {
		throw new Error(`shard index must be between 0 and ${total - 1}`);
	}
	// Hash is already a stable hex digest of the URL; its numeric value spreads
	// sites evenly and never changes as the config list is reordered.
	return sites.filter((s) => Number.parseInt(s.hash.slice(0, 8), 16) % total === index);
}

/** Parse `--shard=1/4` into { index, total }. Accepts 1-based input. */
export function parseShard(value) {
	if (!value) return null;
	const m = String(value).match(/^(\d+)\s*\/\s*(\d+)$/);
	if (!m) throw new Error(`--shard must look like 1/4, got "${value}"`);

	const total = Number(m[2]);
	const oneBased = Number(m[1]);
	if (oneBased < 1 || oneBased > total) throw new Error(`--shard index must be between 1 and ${total}`);

	return { index: oneBased - 1, total };
}

/**
 * Consecutive-failure count for the record about to be written, so the next
 * scheduler run can back off without re-reading history.
 */
export function nextFailureCount(previous, failed) {
	if (!failed) return 0;
	return (previous?.consecutiveFailures || 0) + 1;
}
