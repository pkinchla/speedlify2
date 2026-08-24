import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, selectSites } from "../lib/config.js";
import { urlHash, normalizeUrl } from "../lib/hash.js";

/**
 * Loading config/sites.js: defaults, flattening groups into one measurable list,
 * per-category overrides, and the validation that stops a typo from silently
 * dropping a site.
 *
 * Multi-group membership itself is covered in groups.test.js; what is tested
 * here is everything else loadConfig() decides.
 */

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function configFile(source) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-config-"));
	tmp.push(dir);
	const file = path.join(dir, "sites.js");
	fs.writeFileSync(file, source);
	return file;
}

/** Write a config object out as a module and load it back. */
function load(config) {
	return loadConfig(configFile(`export default ${JSON.stringify(config)};`));
}

const oneSite = (extra = {}) => ({
	groups: { a: { name: "A", sites: [{ url: "https://example.com/" }] } },
	...extra,
});

describe("defaults", () => {
	test("supplies the settings a config omits", async () => {
		const config = await load(oneSite());
		assert.equal(config.runs, 3);
		assert.equal(config.formFactor, "mobile");
		assert.equal(config.freshnessHours, 20);
		assert.equal(config.staleAfterHours, 48);
		assert.equal(config.historyLimit, 120);
		assert.equal(config.redirectConfirmations, 3);
		assert.equal(config.batchSize, null);
	});

	test("a config value wins over the default", async () => {
		const config = await load(oneSite({ runs: 1, formFactor: "desktop", batchSize: 40 }));
		assert.equal(config.runs, 1);
		assert.equal(config.formFactor, "desktop");
		assert.equal(config.batchSize, 40);
	});
});

describe("flattening groups into sites", () => {
	test("gives every site a normalized url, hash and name", async () => {
		const { sites } = await load({
			groups: { a: { name: "A", sites: [{ url: "https://EXAMPLE.com" }] } },
		});
		assert.equal(sites.length, 1);
		assert.equal(sites[0].url, normalizeUrl("https://EXAMPLE.com"));
		assert.equal(sites[0].hash, urlHash("https://example.com/"));
		// No name given, so the hostname stands in.
		assert.equal(sites[0].name, "example.com");
	});

	test("keeps an explicit name", async () => {
		const { sites } = await load({
			groups: { a: { sites: [{ name: "Example", url: "https://example.com/" }] } },
		});
		assert.equal(sites[0].name, "Example");
	});

	test("resolves the group name, falling back to its id", async () => {
		const { sites } = await load({
			groups: {
				named: { name: "Nice Name", sites: [{ url: "https://a.example/" }] },
				bare: { sites: [{ url: "https://b.example/" }] },
			},
		});
		const [a, b] = sites;
		assert.equal(a.group, "named");
		assert.equal(a.groupName, "Nice Name");
		assert.equal(b.groupName, "bare");
	});

	test("normalizes previousUrls too", async () => {
		const { sites } = await load({
			groups: {
				a: { sites: [{ url: "https://example.com/", previousUrls: ["https://OLD.example"] }] },
			},
		});
		assert.deepEqual(sites[0].previousUrls, [normalizeUrl("https://OLD.example")]);
	});

	test("a site with no groups yields no sites", async () => {
		const { sites } = await load({ groups: {} });
		assert.deepEqual(sites, []);
	});
});

describe("validation", () => {
	test("rejects a membership naming an undefined group", async () => {
		await assert.rejects(
			() => load({ groups: { a: { sites: [{ url: "https://example.com/", groups: ["nope"] }] } } }),
			/not defined in config\/sites\.js/,
		);
	});

	test("rejects a previousUrl that is also measured in its own right", async () => {
		// Otherwise that history would be counted twice, in two places.
		await assert.rejects(
			() =>
				load({
					groups: {
						a: {
							sites: [
								{ url: "https://new.example/", previousUrls: ["https://old.example/"] },
								{ url: "https://old.example/" },
							],
						},
					},
				}),
			/also measured as its own site/,
		);
	});

	test("rejects a site listing itself as its own predecessor", async () => {
		// Caught by the "also measured" check above rather than by the dedicated
		// self-reference message: a measured site is always in that set, so the
		// self-reference branch in loadConfig is unreachable. Asserted as it
		// behaves, not as the code reads.
		await assert.rejects(
			() =>
				load({
					groups: {
						a: { sites: [{ url: "https://example.com/", previousUrls: ["https://example.com/"] }] },
					},
				}),
			/also measured as its own site/,
		);
	});
});

describe("rate limits", () => {
	test("inherit from the group, and a site overrides them", async () => {
		const { sites } = await load({
			groups: {
				a: {
					rateLimit: { delayMs: 3000 },
					sites: [{ url: "https://a.example/" }, { url: "https://b.example/", rateLimit: { delayMs: 10 } }],
				},
			},
		});
		assert.deepEqual(sites[0].rateLimit, { delayMs: 3000 });
		assert.deepEqual(sites[1].rateLimit, { delayMs: 10 });
	});

	test("default to null when nothing declares one", async () => {
		const { sites } = await load(oneSite());
		assert.equal(sites[0].rateLimit, null);
	});
});

describe("cadence overrides", () => {
	const base = { freshnessHours: 100, staleAfterHours: 200 };

	test("a site inherits the top-level cadence by default", async () => {
		const { sites } = await load({ ...base, ...oneSite() });
		assert.equal(sites[0].freshnessHours, 100);
		assert.equal(sites[0].staleAfterHours, 200);
	});

	test("a group overrides the top level", async () => {
		const { sites } = await load({
			...base,
			groups: {
				a: {
					freshnessHours: 12,
					staleAfterHours: 24,
					retryErrorsAfterHours: 2,
					sites: [{ url: "https://example.com/" }],
				},
			},
		});
		assert.equal(sites[0].freshnessHours, 12);
		assert.equal(sites[0].staleAfterHours, 24);
		assert.equal(sites[0].retryErrorsAfterHours, 2);
	});

	test("the error-retry interval defaults to the next run", async () => {
		const { sites } = await load(oneSite());
		assert.equal(sites[0].retryErrorsAfterHours, 0);
	});

	test("a site overrides its group", async () => {
		const { sites } = await load({
			...base,
			groups: {
				a: { freshnessHours: 12, sites: [{ url: "https://example.com/", freshnessHours: 3 }] },
			},
		});
		assert.equal(sites[0].freshnessHours, 3);
	});

	test("across categories the stricter cadence wins", async () => {
		// One URL in two groups. Listing it somewhere slow must not undo the
		// cadence a faster category asked for.
		const { sites } = await load({
			...base,
			groups: {
				fast: { freshnessHours: 6, staleAfterHours: 12, sites: [{ url: "https://example.com/" }] },
				slow: { freshnessHours: 400, staleAfterHours: 800, sites: [{ url: "https://example.com/" }] },
			},
		});
		assert.equal(sites.length, 1, "still one measured entry");
		assert.deepEqual(sites[0].groups, ["fast", "slow"]);
		assert.equal(sites[0].freshnessHours, 6);
		assert.equal(sites[0].staleAfterHours, 12);
	});

	test("the stricter cadence wins regardless of listing order", async () => {
		const { sites } = await load({
			...base,
			groups: {
				slow: { freshnessHours: 400, sites: [{ url: "https://example.com/" }] },
				fast: { freshnessHours: 6, sites: [{ url: "https://example.com/" }] },
			},
		});
		assert.equal(sites[0].freshnessHours, 6);
	});
});

describe("selectSites", () => {
	async function threeSites() {
		const { sites } = await load({
			groups: {
				a: { sites: [{ name: "Alpha", url: "https://alpha.example/" }] },
				b: { sites: [{ name: "Beta", url: "https://beta.example/" }, { url: "https://gamma.example/" }] },
			},
		});
		return sites;
	}

	test("filters by group", async () => {
		const sites = await threeSites();
		assert.deepEqual(selectSites(sites, { group: "b" }).map((s) => s.url), [
			"https://beta.example/",
			"https://gamma.example/",
		]);
	});

	test("accepts several groups", async () => {
		const sites = await threeSites();
		assert.equal(selectSites(sites, { group: "a,b" }).length, 3);
	});

	test("filters by exact url, normalized", async () => {
		const sites = await threeSites();
		assert.deepEqual(selectSites(sites, { url: "https://ALPHA.example" }).map((s) => s.name), ["Alpha"]);
	});

	test("filters by name or url substring, case-insensitively", async () => {
		const sites = await threeSites();
		assert.deepEqual(selectSites(sites, { filter: "bet" }).map((s) => s.name), ["Beta"]);
		assert.deepEqual(selectSites(sites, { filter: "GAMMA" }).map((s) => s.url), ["https://gamma.example/"]);
	});

	test("returns everything with no flags", async () => {
		const sites = await threeSites();
		assert.equal(selectSites(sites, {}).length, 3);
		assert.equal(selectSites(sites).length, 3);
	});
});

describe("disabling a category", () => {
	const base = (extra) => ({
		groups: {
			a: { name: "A", sites: [{ url: "https://a.example/" }, { url: "https://shared.example/" }] },
			b: { name: "B", sites: [{ url: "https://b.example/" }, { url: "https://shared.example/" }] },
			...extra,
		},
	});

	test("is on by default, and `enabled: true` changes nothing", async () => {
		const on = await load(base());
		assert.equal(on.sites.length, 3);
		const explicit = await load({
			groups: { a: { name: "A", enabled: true, sites: [{ url: "https://a.example/" }] } },
		});
		assert.equal(explicit.sites.length, 1);
	});

	test("drops the category and its exclusive sites", async () => {
		const config = await load(base());
		config.groups.b.enabled = false;
		const off = await load({ groups: { ...config.groups, b: { ...config.groups.b, enabled: false } } });

		assert.equal(off.groups.b, undefined, "the category is gone from the config");
		assert.deepEqual(
			off.sites.map((s) => s.url).sort(),
			["https://a.example/", "https://shared.example/"],
			"b's exclusive site drops, the shared one stays",
		);
	});

	test("a shared site keeps its other memberships", async () => {
		const off = await load({
			groups: {
				a: { name: "A", sites: [{ url: "https://shared.example/" }] },
				b: { name: "B", enabled: false, sites: [{ url: "https://shared.example/" }] },
			},
		});
		assert.deepEqual(off.sites[0].groups, ["a"]);
	});

	test("a membership naming a disabled category is dropped, not rejected", async () => {
		// Switching a category off must not turn every site referencing it into a
		// config error.
		const off = await load({
			groups: {
				a: { name: "A", sites: [{ url: "https://a.example/", groups: ["b"] }] },
				b: { name: "B", enabled: false, sites: [] },
			},
		});
		assert.deepEqual(off.sites[0].groups, ["a"]);
	});

	test("a rule pointing at a disabled category is dropped", async () => {
		// Otherwise the report would throw on a destination that no longer exists.
		const off = await load({
			groups: {
				a: { name: "A", requireGenerator: ["eleventy"], emeritusGroup: "b", sites: [{ url: "https://a.example/" }] },
				b: { name: "B", enabled: false, sites: [] },
			},
		});
		assert.equal(off.groups.a.emeritusGroup, undefined);
		assert.deepEqual(off.groups.a.requireGenerator, ["eleventy"]);
	});
});

describe("archived sites", () => {
	/**
	 * Archiving is the middle option between deleting a URL and leaving it in
	 * the leaderboard. The site stays configured — which is what keeps its
	 * stored history from reading as an orphan — and carries a flag that the
	 * scheduler and the report both act on.
	 */
	const config = (urls) => ({
		archived: urls,
		groups: {
			g: {
				name: "Group",
				sites: [{ url: "https://kept.example/" }, { url: "https://gone.example/" }],
			},
		},
	});

	test("marks only the listed URLs", async () => {
		const { sites } = await load(config(["https://gone.example/"]));

		assert.equal(sites.find((s) => s.url === "https://gone.example/").archived, true);
		assert.equal(sites.find((s) => s.url === "https://kept.example/").archived, false);
	});

	test("keeps the site in the list rather than dropping it", async () => {
		// Dropping it would leave its stored history with nothing claiming it,
		// which the report would then file as an orphan — the opposite of what
		// archiving means.
		const { sites } = await load(config(["https://gone.example/"]));
		assert.equal(sites.length, 2);
	});

	test("normalizes the list, so it can be written the way a person types it", async () => {
		const { sites } = await load({
			archived: ["https://gone.example/deep/"],
			groups: { g: { name: "Group", sites: [{ url: "https://gone.example/deep" }] } },
		});

		assert.equal(sites[0].archived, true, "trailing slash must not decide this");
	});

	test("marks a URL across every category it appears in", async () => {
		const { sites } = await load({
			archived: ["https://gone.example/"],
			groups: {
				a: { name: "A", sites: [{ url: "https://gone.example/" }] },
				b: { name: "B", sites: [{ url: "https://gone.example/" }] },
			},
		});

		assert.equal(sites.length, 1, "one URL, one site");
		assert.equal(sites[0].archived, true);
		assert.deepEqual(sites[0].groups, ["a", "b"]);
	});

	test("is absent rather than false when nothing is archived", async () => {
		const { sites } = await load(config([]));
		assert.equal(sites.every((s) => s.archived === false), true);
	});
});

describe("pinning a site to its configured categories", () => {
	function fixture(extra = {}) {
		return {
			...extra,
			groups: {
				community: {
					name: "Community",
					requireGenerator: ["eleventy"],
					emeritusGroup: "emeritus",
					sites: [{ url: "https://moved.example/" }, { url: "https://pinned.example/" }],
				},
				emeritus: { name: "Emeritus", rejectGenerator: ["eleventy"], rejectGroup: "community", sites: [] },
			},
		};
	}

	test("the list form marks the matching sites", async () => {
		const config = await load(fixture({ pinned: ["https://pinned.example/"] }));
		const byUrl = Object.fromEntries(config.sites.map((s) => [s.url, s]));

		assert.equal(byUrl["https://pinned.example/"].pinGroup, true);
		assert.equal(byUrl["https://moved.example/"].pinGroup, false);
	});

	test("normalizes before matching, like the archived list", async () => {
		const config = await load(fixture({ pinned: ["https://pinned.example"] }));
		const site = config.sites.find((s) => s.url === "https://pinned.example/");
		assert.equal(site.pinGroup, true);
	});

	test("a site entry can carry the flag itself", async () => {
		const config = await load({
			groups: {
				community: { name: "Community", sites: [{ url: "https://hand.example/", pinGroup: true }] },
			},
		});
		assert.equal(config.sites[0].pinGroup, true);
	});

	test("nothing is pinned by default", async () => {
		const config = await load(fixture());
		assert.ok(config.sites.every((s) => s.pinGroup === false));
	});
});
