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
				{ url: "https://paulkinchla.com" },
				{ url: "https://paulkinchla.com/about/" },
				{ url: "https://paulkinchla.com/projects/" },
				{ url: "https://paulkinchla.com/blog/" },
				{ url: "https://paulkinchla.com/blog/2020/10/28/javascript-still-a-ghost/" },
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
