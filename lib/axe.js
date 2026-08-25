import puppeteer from "puppeteer-core";
import { AxePuppeteer } from "@axe-core/puppeteer";
import { pageProbe, detectGenerator, detectHost, pickHostHeaders, detectInterstitial } from "./stack.js";

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
 *
 * The pass also carries the site's two screenshots, because it is already
 * holding a loaded page: one as the browser renders it, and one with scripts
 * disabled. Capturing them here rather than asking screenshot.11ty.dev for a
 * picture later means the image is of the same page load that produced the
 * numbers beside it, and the published site has no runtime dependency on
 * another service being up.
 */

/**
 * Screenshot encoding. WebP at 80 because these are stored for every site and
 * committed: the same frame as JPEG is roughly a third larger for no visible
 * gain at this size.
 */
const SHOT = { type: "webp", quality: 80 };

/**
 * Take a viewport screenshot of an already-loaded page.
 *
 * Deliberately not `fullPage`. The two captures are meant to be read as a pair,
 * and a full-page shot makes them different shapes — a site that renders
 * nothing without JavaScript would produce a tall picture and a short one, so
 * the comparison would be between two aspect ratios rather than two renders.
 *
 * The viewport is whatever the caller set, and is reported back rather than
 * parsed out of the encoded bytes, so the page can reserve the right box before
 * the image loads.
 */
async function grab(page) {
	const viewport = page.viewport() ?? {};
	const buffer = await page.screenshot({ ...SHOT, fullPage: false });

	return {
		// Puppeteer hands back a Uint8Array; everything downstream writes Buffers.
		buffer: Buffer.from(buffer),
		type: SHOT.type,
		width: viewport.width ?? null,
		height: viewport.height ?? null,
	};
}

/**
 * Load the page again with scripts disabled, and photograph that.
 *
 * A second page rather than a second navigation on the first one: the axe run
 * needs the page as the browser really renders it, and
 * `Emulation.setScriptExecutionDisabled` only takes effect on the *next*
 * navigation, so the flag has to be set before the goto rather than after.
 *
 * `load` alone, not the `networkidle0` the axe navigation waits for. With no
 * scripts running there is no second wave of requests to settle, and
 * networkidle0 is what makes a handful of sites sit at the timeout for two
 * minutes.
 *
 * Never throws. A missing no-JS picture is worth less than the measurement it
 * would take down with it.
 */
async function captureWithoutJavaScript(browser, url, viewport, timeoutMs) {
	let page;

	try {
		page = await browser.newPage();
		if (viewport?.width) await page.setViewport(viewport);
		await page.setJavaScriptEnabled(false);
		await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

		return await grab(page);
	} catch {
		return null;
	} finally {
		if (page) await page.close().catch(() => {});
	}
}

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
export async function runAxe(url, { port, timeoutMs = 60000, screenshots = false } = {}) {
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

		/*
		 * Both captures happen before axe runs and at the viewport axe uses.
		 *
		 * Before, because axe injects its own bundle into the page and the
		 * picture should be of the site rather than of the site plus a test
		 * harness. At the same viewport, because resizing to something more
		 * photogenic would re-run every responsive breakpoint the accessibility
		 * numbers are measured at — and those numbers feed the ranking.
		 */
		const shots = screenshots
			? {
					js: await grab(page).catch(() => null),
					noJs: await captureWithoutJavaScript(browser, url, page.viewport(), timeoutMs),
				}
			: null;

		const results = await new AxePuppeteer(page).analyze();

		return {
			shots,
			generator: detectGenerator(probe, headers),
			// Set when the page we measured was a bot check rather than the site.
			// Null is the ordinary case.
			interstitial: detectInterstitial(probe),
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
			shots: null,
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
