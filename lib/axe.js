import puppeteer from "puppeteer-core";
import { AxePuppeteer } from "@axe-core/puppeteer";
import { pageProbe, detectGenerator, detectHost, pickHostHeaders } from "./stack.js";

/**
 * Standalone axe-core accessibility pass.
 *
 * Lighthouse embeds axe, but only runs a subset of its rules and folds the
 * outcome into a weighted score. The leaderboard tiebreaker needs the raw
 * count of violating nodes from a full axe run, which is a different and
 * stricter measurement — a page can score 92 in Lighthouse and still have
 * a dozen violations here.
 *
 * This connects to the Chrome that `chrome-launcher` already started for
 * Lighthouse rather than launching a second browser, so the extra cost is one
 * page load per site.
 */

/**
 * Count violating (or passing) *nodes*, not rules.
 *
 * One rule broken across eight elements is eight violations. Counting rules
 * instead would rank a page with one widespread failure above a page with two
 * isolated ones. Rules that report no nodes still count once.
 */
export function countNodes(entries) {
	let count = 0;
	for (let entry of entries || []) {
		count += entry.nodes?.length ? entry.nodes.length : 1;
	}
	return count;
}

/**
 * Run axe against a URL using an already-running Chrome.
 *
 * Never throws: accessibility results are a tiebreaker, and losing a whole
 * measurement because axe timed out on one heavy page would be a bad trade.
 * A failure comes back as `{ error }` with null counts.
 */
export async function runAxe(url, { port, timeoutMs = 60000 } = {}) {
	let browser;
	let page;

	try {
		// `connect`, not `launch` — and `disconnect` below, not `close`, because
		// this Chrome belongs to the Lighthouse runner and must outlive us.
		browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
		page = await browser.newPage();

		// Sites with a strict CSP would otherwise block the injected axe bundle.
		await page.setBypassCSP(true);
		const response = await page.goto(url, { waitUntil: ["load", "networkidle0"], timeout: timeoutMs });

		// Stack detection rides along on this page load rather than costing a
		// second request — see lib/stack.js.
		const headers = pickHostHeaders(response?.headers() || {});
		const probe = await page.evaluate(pageProbe).catch(() => ({ meta: null, marks: [] }));

		const results = await new AxePuppeteer(page).analyze();

		return {
			generator: detectGenerator(probe, headers),
			host: detectHost(headers),
			headers,
			violations: countNodes(results.violations),
			passes: countNodes(results.passes),
			incomplete: countNodes(results.incomplete),
			// Distinct rules broken, alongside the node count the ranking uses.
			violationRules: results.violations?.length ?? 0,
			version: results.testEngine?.version ?? null,
			// Enough detail to act on, without storing every node.
			top: (results.violations || [])
				.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes?.length ?? 0, help: v.help }))
				.sort((a, b) => b.nodes - a.nodes)
				.slice(0, 10),
			error: null,
		};
	} catch (err) {
		return {
			generator: null,
			host: null,
			headers: {},
			violations: null,
			passes: null,
			incomplete: null,
			violationRules: null,
			version: null,
			top: [],
			error: err.message,
		};
	} finally {
		if (page) await page.close().catch(() => {});
		// Detach without killing the browser Lighthouse is still using.
		if (browser) browser.disconnect();
	}
}
