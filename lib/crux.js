/**
 * Chrome UX Report (CrUX) — real-user Core Web Vitals from Google.
 *
 * Why this exists alongside Lighthouse: lab data is a simulation on one machine
 * with synthetic throttling. Field data is what actually happened to real
 * Chrome users over a 28-day window. They diverge, and the divergence is
 * frequently the most interesting thing on the chart — lab flat while field
 * degrades usually means a population you don't test on (slow devices, bad
 * networks, a region you added).
 *
 * It is also the ONLY way to get INP. Lighthouse cannot measure interaction
 * latency in a lab run; `inp-breakdown-insight` is null on a cold navigation.
 *
 * Requires a Google API key with the Chrome UX Report API enabled:
 *   https://developers.google.com/chrome/ux-report/
 * Set it as CRUX_API_KEY.
 *
 * Caveats worth remembering when reading the charts:
 *  - Only origins/URLs with enough Chrome traffic are included. Small sites
 *    return 404 (NOT_FOUND) — that's normal, not a failure.
 *  - The window is a trailing 28 days, so it moves slowly and lags a deploy.
 *  - URL-level data is sparser than origin-level. We fall back automatically.
 */

const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const HISTORY_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

/** The metrics we request. Others exist but these are the ones worth charting. */
export const CRUX_METRICS = [
	"largest_contentful_paint",
	"cumulative_layout_shift",
	"interaction_to_next_paint",
	"first_contentful_paint",
	"experimental_time_to_first_byte",
	"round_trip_time",
];

/** Google's official good/needs-improvement/poor boundaries. */
export const CWV_THRESHOLDS = {
	lcp: { good: 2500, poor: 4000, unit: "ms" },
	cls: { good: 0.1, poor: 0.25, unit: "" },
	inp: { good: 200, poor: 500, unit: "ms" },
	fcp: { good: 1800, poor: 3000, unit: "ms" },
	ttfb: { good: 800, poor: 1800, unit: "ms" },
};

const SHORT_NAME = {
	largest_contentful_paint: "lcp",
	cumulative_layout_shift: "cls",
	interaction_to_next_paint: "inp",
	first_contentful_paint: "fcp",
	experimental_time_to_first_byte: "ttfb",
	round_trip_time: "rtt",
};

export function rate(metric, value) {
	const t = CWV_THRESHOLDS[metric];
	if (!t || value === null || value === undefined) return null;
	if (value <= t.good) return "good";
	if (value <= t.poor) return "needs-improvement";
	return "poor";
}

/**
 * CrUX returns CLS percentiles as a STRING ("0.05") while timing metrics come
 * back as numbers. Coercing blindly is how you end up with NaN in a chart.
 */
function toNumber(v) {
	if (v === null || v === undefined) return null;
	const n = typeof v === "string" ? Number.parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

function collectionDate(d) {
	if (!d) return null;
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/**
 * Histogram densities → the good/needs-improvement/poor split, as percentages.
 * This is richer than p75 alone: p75 can hold steady while the poor bucket
 * doubles, which is a real regression for a real slice of your users.
 */
function buckets(histogram) {
	if (!Array.isArray(histogram) || histogram.length < 3) return null;
	const pct = (i) => {
		const d = toNumber(histogram[i]?.density);
		return d === null ? null : Math.round(d * 1000) / 10;
	};
	return { good: pct(0), needsImprovement: pct(1), poor: pct(2) };
}

/**
 * CrUX allows 150 queries per minute, per Google Cloud *project* — so anything
 * else using the same key shares it.
 *
 * A plain `for … await` loop is not slow enough on its own: the API answers in
 * a couple of hundred milliseconds, so an unpaced loop issues three to five
 * hundred requests a minute and starts failing about thirty seconds in, then
 * keeps failing for the rest of the run.
 *
 * 420ms between requests is ~143/minute, just under the limit with enough
 * margin to absorb a fast response.
 */
const MIN_REQUEST_GAP_MS = 420;

/** Retries after a 429, doubling each time. Past this the quota is not the problem. */
const RATE_LIMIT_RETRIES = 3;

let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Space requests out, measured from when the last one was actually issued. */
async function pace() {
	const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastRequestAt = Date.now();
}

async function postJson(endpoint, apiKey, body) {
	for (let attempt = 0; ; attempt++) {
		await pace();

		const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		const json = await res.json().catch(() => null);

		if (res.ok) return json;

		// Being throttled is not a fact about the site — it is a fact about how
		// fast we asked. Backing off and asking again is the whole fix; giving up
		// would leave the site with no field data until the next backfill.
		if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
			// Honour Retry-After when the API sends one, since it knows better.
			const retryAfter = Number.parseInt(res.headers?.get?.("retry-after") ?? "", 10);
			const backoff = Number.isFinite(retryAfter)
				? retryAfter * 1000
				: MIN_REQUEST_GAP_MS * 4 * 2 ** attempt;
			await sleep(backoff);
			continue;
		}

		const err = new Error(json?.error?.message || `CrUX HTTP ${res.status}`);
		err.status = res.status;
		// 404 means "not enough traffic to report", which is an expected outcome
		// for smaller sites rather than something to retry or shout about.
		err.notFound = res.status === 404;
		err.rateLimited = res.status === 429;
		throw err;
	}
}

/**
 * Current 28-day field data for a URL.
 *
 * Tries URL-level first (more specific), falls back to origin-level, which is
 * what most sites will actually have. The returned record says which you got —
 * never silently mix the two in one series.
 */
export async function fetchFieldData(url, { apiKey, formFactor = "PHONE", scope = "auto" } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url, scope: "url" });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		// Omitting formFactor aggregates all devices; "ALL" is not a valid value.
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(ENDPOINT, apiKey, body);
			return normalizeRecord(json, attemptScope, formFactor);
		} catch (err) {
			lastError = err;
			if (err.notFound) continue; // try the next, broader scope
			throw err;
		}
	}

	if (lastError?.notFound) return null; // genuinely no field data for this site
	throw lastError;
}

function normalizeRecord(json, scope, formFactor) {
	const record = json?.record;
	if (!record) return null;

	const metrics = {};
	for (let [name, data] of Object.entries(record.metrics || {})) {
		const short = SHORT_NAME[name];
		if (!short) continue;

		const p75 = toNumber(data?.percentiles?.p75);
		metrics[short] = {
			p75,
			rating: rate(short, p75),
			distribution: buckets(data?.histogram),
		};
	}

	// Overall pass = all three Core Web Vitals in the "good" band at p75.
	// Note the explicit null check rather than `every(...) || null`: that idiom
	// silently turns a real "fails CWV" (false) into "no data" (null), which is
	// exactly backwards for the site you most want to notice.
	const cwvRatings = ["lcp", "cls", "inp"].map((k) => metrics[k]?.rating).filter(Boolean);
	const cwvPass = cwvRatings.length ? cwvRatings.every((r) => r === "good") : null;

	return {
		source: "crux",
		scope,
		formFactor,
		collectionPeriod: {
			first: collectionDate(record.collectionPeriod?.firstDate),
			last: collectionDate(record.collectionPeriod?.lastDate),
		},
		metrics,
		cwvPass,
		// How many of the three were actually reported — a "pass" on two of three
		// is not the same claim as a pass on all three.
		cwvAssessed: cwvRatings.length,
	};
}

/**
 * Weekly p75 history — roughly 25 weeks in a single request.
 *
 * This is the fastest way to make a brand-new install useful: instead of
 * waiting months to accumulate a trend, you get six months of real-user
 * history immediately.
 */
export async function fetchFieldHistory(url, { apiKey, formFactor = "PHONE", scope = "auto" } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url, scope: "url" });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(HISTORY_ENDPOINT, apiKey, body);
			return normalizeHistory(json, attemptScope, formFactor);
		} catch (err) {
			lastError = err;
			if (err.notFound) continue;
			throw err;
		}
	}

	if (lastError?.notFound) return null;
	throw lastError;
}

function normalizeHistory(json, scope, formFactor) {
	const record = json?.record;
	if (!record) return null;

	const periods = (record.collectionPeriods || []).map((p) => ({
		first: collectionDate(p?.firstDate),
		last: collectionDate(p?.lastDate),
	}));

	// Transpose Google's metric-major timeseries into one row per week, which
	// is what every chart and table downstream actually wants.
	const series = periods.map((period, i) => {
		const point = { period, date: period.last, metrics: {} };

		for (let [name, data] of Object.entries(record.metrics || {})) {
			const short = SHORT_NAME[name];
			if (!short) continue;

			const p75 = toNumber(data?.percentilesTimeseries?.p75s?.[i]);
			const densities = data?.histogramTimeseries;
			const density = (b) => {
				const d = toNumber(densities?.[b]?.densities?.[i]);
				return d === null ? null : Math.round(d * 1000) / 10;
			};

			point.metrics[short] = {
				p75,
				rating: rate(short, p75),
				distribution: Array.isArray(densities) && densities.length >= 3
					? { good: density(0), needsImprovement: density(1), poor: density(2) }
					: null,
			};
		}

		return point;
	});

	return { source: "crux-history", scope, formFactor, series };
}

/** One-shot connectivity/shape check so key problems surface immediately. */
export async function checkApiKey(apiKey, testOrigin = "https://web.dev") {
	const result = await fetchFieldData(testOrigin, { apiKey, scope: "origin" });
	return result;
}
