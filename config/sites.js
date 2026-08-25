/**
 * Site list for this checkout.
 *
 * Replaces the upstream zachleat/speedlify2 example config (Site Generators,
 * Test Runners, Web Hosts, zachleat.com, the 11ty community/starters/emeritus
 * imports) with just the two categories this fork actually tracks — same two
 * as `_data/sites/paulkinchladotcom.js` and `_data/sites/sevenpx.js` in the v1
 * fork.
 */

/** Hand-maintained handfuls: measured daily, stale after two days. */
const DAILY = { freshnessHours: 24, staleAfterHours: 48 };

/**
 * paulkinchla.com sits behind a Cloudflare bot challenge. A WAF custom rule
 * there skips the challenge for requests whose User-Agent carries this
 * secret token — see the CLOUDFLARE_BYPASS_SECRET env var (set in `.env`
 * locally, and as a GitHub Actions repo secret in production).
 *
 * Lighthouse's own navigation gets through untagged; only the standalone axe
 * pass's separate page load needs this — see `site.userAgent` in
 * lib/runner.js / lib/axe.js.
 *
 * Verified live (2026-08-25): the axe pass gets served Cloudflare's "Just a
 * moment..." interstitial without this tag on all 5 paulkinchla.com URLs.
 *
 * That fixes the axe pass, but the site's own screenshot is a separate
 * problem: the report falls back to the external screenshot.11ty.dev service
 * whenever a site has no `ownScreenshot` (see src/site.njk), and that service
 * is a third party we have no way to tag — it always gets Cloudflare's
 * interstitial for these URLs. `screenshotBlocked: true` below is the
 * project's existing answer for exactly this (see the `screenshotBlocked`
 * config docs — solidjs.com is the precedent): it keeps Lighthouse's own
 * full-page capture instead and prefers it on the page.
 */
const CLOUDFLARE_BYPASS_SECRET = process.env.CLOUDFLARE_BYPASS_SECRET;

/**
 * Other people's sites, mostly on modest hosting, measured at a deliberate
 * pace. Measurement is already sequential — one Chrome, one run at a time —
 * so nothing is ever requested concurrently; this governs the pace on top of
 * that.
 */
const POLITE = { rateLimit: { delayMs: 3000, hostCooldownMs: 60000 } };

export default {
	runs: 3,
	formFactor: "mobile",

	groups: {
		paulkinchladotcom: {
			name: "paulkinchla.com",
			description: "My personal website.",
			enabled: true,
			...DAILY,
			...POLITE,
			sites: [
				{ url: "https://paulkinchla.com", userAgent: CLOUDFLARE_BYPASS_SECRET, screenshotBlocked: true },
				{
					url: "https://paulkinchla.com/about/",
					userAgent: CLOUDFLARE_BYPASS_SECRET,
					screenshotBlocked: true,
				},
				{
					url: "https://paulkinchla.com/projects/",
					userAgent: CLOUDFLARE_BYPASS_SECRET,
					screenshotBlocked: true,
				},
				{
					url: "https://paulkinchla.com/blog/",
					userAgent: CLOUDFLARE_BYPASS_SECRET,
					screenshotBlocked: true,
				},
				{
					url: "https://paulkinchla.com/blog/2020/10/28/javascript-still-a-ghost/",
					userAgent: CLOUDFLARE_BYPASS_SECRET,
					screenshotBlocked: true,
				},
			],
		},

		sevenpx: {
			name: "sevenpx.design",
			description: "Side project about drawing using Fresh",
			enabled: true,
			...DAILY,
			...POLITE,
			sites: [
				{ url: "https://sevenpx.design" },
				{ url: "https://sevenpx.design/drawings/" },
			],
		},
	},
};
