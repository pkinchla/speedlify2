/**
 * The starting configuration for a new instance.
 *
 * `npm run reset` copies this over `config/sites.js`, which is the file the
 * measurement and report steps actually read. Edit that one; this stays as the
 * thing to fall back to.
 *
 * Everything below is the smallest configuration that runs. The upstream
 * project's own config carries several hundred more lines — imported community
 * lists, pinned URLs, archived sites, per-category politeness — none of which
 * mean anything outside that instance. Add what you need as you need it; the
 * defaults here are chosen so that measuring three sites works on the first
 * `npm run measure` without touching anything else.
 */

export default {
	// Lighthouse runs per URL per measurement. The median run is kept. 3 trades
	// wall-clock time for a number that is not one noisy sample.
	runs: 3,

	// "filmstrip" keeps Lighthouse's loading frames for each site; "none" keeps
	// only the two screenshots the axe pass takes. Frames are committed, so a
	// large site list is a reason to turn them off per category.
	screenshots: "filmstrip",

	// "mobile" matches what Lighthouse scores by default and what the published
	// numbers mean. `--desktop` overrides it for a single run.
	formFactor: "mobile",

	// How long a measurement counts as current, and how long before a site is
	// reported as stale. Both are overridable per category and per site.
	freshnessHours: 24,
	staleAfterHours: 48,

	// Sites per `npm run measure`. The stalest are chosen first.
	batchSize: 20,

	// Measurements kept per site before the oldest are pruned by `npm run clean`.
	historyLimit: 120,

	// A site whose last attempt errored waits this long before being tried
	// again, and that wait doubles with each consecutive failure when
	// `failureBackoff` is on: 1h, 2, 4, 8, 16, capped at 24.
	retryErrorsAfterHours: 6,
	failureBackoff: true,

	// How many consecutive measurements must agree on a redirect before it is
	// treated as a move rather than a blip.
	redirectConfirmations: 3,

	groups: {
		example: {
			name: "Example",
			enabled: true,
			description: "Replace these with the sites you want to measure.",
			sites: [
				{ name: "Eleventy", url: "https://www.11ty.dev/" },
				{ name: "Speedlify", url: "https://www.speedlify.dev/" },
				{ name: "zachleat.com", url: "https://www.zachleat.com/" },
			],
		},
	},
};
