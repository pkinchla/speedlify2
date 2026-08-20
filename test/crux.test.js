import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchFieldData, fetchFieldHistory, rate } from "../lib/crux.js";

/**
 * The CrUX client is tested against mocked responses in the documented v1
 * shape, because hitting the real API needs a key and would make the suite
 * depend on the network and on a specific site's traffic.
 */

const realFetch = globalThis.fetch;
let lastBody = null;

function mockResponse(payload, status = 200) {
	globalThis.fetch = async (url, opts) => {
		lastBody = JSON.parse(opts.body);
		return { ok: status === 200, status, json: async () => payload };
	};
}

const CURRENT = {
	record: {
		key: { formFactor: "PHONE", origin: "https://example.com" },
		metrics: {
			largest_contentful_paint: {
				percentiles: { p75: 2300 },
				histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
			},
			// The API returns CLS percentiles as a string while timings are numbers.
			cumulative_layout_shift: {
				percentiles: { p75: "0.05" },
				histogram: [{ density: 0.9 }, { density: 0.07 }, { density: 0.03 }],
			},
			interaction_to_next_paint: {
				percentiles: { p75: 210 },
				histogram: [{ density: 0.6 }, { density: 0.3 }, { density: 0.1 }],
			},
		},
		collectionPeriod: {
			firstDate: { year: 2026, month: 7, day: 1 },
			lastDate: { year: 2026, month: 7, day: 28 },
		},
	},
};

beforeEach(() => { lastBody = null; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchFieldData", () => {
	test("parses percentiles, ratings and distributions", async () => {
		mockResponse(CURRENT);
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(r.metrics.lcp.p75, 2300);
		assert.equal(r.metrics.lcp.rating, "good");
		assert.deepEqual(r.metrics.lcp.distribution, { good: 70, needsImprovement: 20, poor: 10 });
		assert.equal(r.collectionPeriod.last, "2026-07-28");
		assert.equal(r.scope, "origin");
	});

	test("coerces the string CLS percentile to a number", async () => {
		mockResponse(CURRENT);
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(typeof r.metrics.cls.p75, "number");
		assert.equal(r.metrics.cls.p75, 0.05);
		assert.ok(!Number.isNaN(r.metrics.cls.p75));
	});

	test("failing Core Web Vitals is false, not null", async () => {
		mockResponse(CURRENT); // INP 210 is above the 200 "good" threshold
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(r.cwvPass, false, "a site that fails CWV must be distinguishable from one with no data");
		assert.equal(r.cwvAssessed, 3);
	});

	test("passes all three when every metric is good", async () => {
		const good = structuredClone(CURRENT);
		good.record.metrics.interaction_to_next_paint.percentiles.p75 = 150;
		mockResponse(good);

		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });
		assert.equal(r.cwvPass, true);
	});

	test("sends the requested form factor", async () => {
		mockResponse(CURRENT);
		await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin", formFactor: "DESKTOP" });
		assert.equal(lastBody.formFactor, "DESKTOP");
	});

	test("404 means not enough traffic, so returns null rather than throwing", async () => {
		mockResponse({ error: { message: "not found" } }, 404);
		const r = await fetchFieldData("https://tiny.example/", { apiKey: "k" });
		assert.equal(r, null);
	});

	test("falls back from URL scope to origin scope", async () => {
		let call = 0;
		globalThis.fetch = async (url, opts) => {
			lastBody = JSON.parse(opts.body);
			call++;
			// First attempt (URL-level) has no data; second (origin-level) does.
			if (call === 1) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => CURRENT };
		};

		const r = await fetchFieldData("https://example.com/deep/page", { apiKey: "k" });
		assert.equal(call, 2);
		assert.equal(r.scope, "origin");
		assert.equal(lastBody.origin, "https://example.com");
	});

	test("requires an API key", async () => {
		await assert.rejects(() => fetchFieldData("https://example.com/", {}), /API key/);
	});

	test("propagates non-404 errors", async () => {
		mockResponse({ error: { message: "quota exceeded" } }, 429);
		await assert.rejects(() => fetchFieldData("https://example.com/", { apiKey: "k" }), /quota exceeded/);
	});
});

describe("fetchFieldHistory", () => {
	const HISTORY = {
		record: {
			collectionPeriods: [
				{ firstDate: { year: 2026, month: 1, day: 1 }, lastDate: { year: 2026, month: 1, day: 28 } },
				{ firstDate: { year: 2026, month: 1, day: 8 }, lastDate: { year: 2026, month: 2, day: 4 } },
			],
			metrics: {
				largest_contentful_paint: {
					percentilesTimeseries: { p75s: [2400, 2600] },
					histogramTimeseries: [
						{ densities: [0.7, 0.65] },
						{ densities: [0.2, 0.22] },
						{ densities: [0.1, 0.13] },
					],
				},
				cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.04", "0.12"] } },
			},
		},
	};

	test("transposes Google's metric-major series into one row per week", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(h.series.length, 2);
		assert.equal(h.series[0].metrics.lcp.p75, 2400);
		assert.equal(h.series[1].metrics.lcp.p75, 2600);
		assert.equal(h.series[1].date, "2026-02-04");
		assert.equal(h.series[1].metrics.lcp.distribution.poor, 13);
	});

	test("coerces string CLS values across the series", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(h.series[1].metrics.cls.p75, 0.12);
		assert.equal(h.series[1].metrics.cls.rating, "needs-improvement");
	});

	test("tolerates a metric with no histogram series", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });
		assert.equal(h.series[0].metrics.cls.distribution, null);
	});
});

describe("rate", () => {
	test("treats threshold boundaries as good", () => {
		assert.equal(rate("lcp", 2500), "good");
		assert.equal(rate("lcp", 2501), "needs-improvement");
		assert.equal(rate("cls", 0.1), "good");
		assert.equal(rate("inp", 200), "good");
	});

	test("classifies the poor band", () => {
		assert.equal(rate("lcp", 4001), "poor");
		assert.equal(rate("inp", 501), "poor");
		assert.equal(rate("cls", 0.3), "poor");
	});

	test("returns null for missing values and unknown metrics", () => {
		assert.equal(rate("lcp", null), null);
		assert.equal(rate("lcp", undefined), null);
		assert.equal(rate("nonsense", 100), null);
	});
});
