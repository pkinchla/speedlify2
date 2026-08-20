import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, selectSites } from "../lib/config.js";

/**
 * A URL may appear in several categories, but is only ever measured and stored
 * once — group membership is presentation, not identity.
 */

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function configFile(source) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-groups-"));
	tmp.push(dir);
	const file = path.join(dir, "sites.js");
	fs.writeFileSync(file, source);
	return file;
}

describe("multi-group sites", () => {
	test("a URL listed in two groups becomes one entry in both", async () => {
		const file = configFile(`export default { groups: {
			a: { name: "A", sites: [{ name: "Shared", url: "https://x.example/" }] },
			b: { name: "B", sites: [{ url: "https://x.example/" }] },
		} };`);

		const config = await loadConfig(file);

		assert.equal(config.sites.length, 1, "one URL, one entry — measured once");
		assert.deepEqual(config.sites[0].groups, ["a", "b"]);
		assert.equal(config.sites[0].name, "Shared", "detail from the first listing is kept");
	});

	test("a site can tag extra categories instead of being listed again", async () => {
		const file = configFile(`export default { groups: {
			a: { name: "A", sites: [{ url: "https://x.example/", groups: ["b"] }] },
			b: { name: "B", sites: [] },
		} };`);

		const config = await loadConfig(file);
		assert.deepEqual(config.sites[0].groups, ["a", "b"]);
	});

	test("the first group is the primary one", async () => {
		const file = configFile(`export default { groups: {
			a: { name: "Alpha", sites: [{ url: "https://x.example/" }] },
			b: { name: "Beta", sites: [{ url: "https://x.example/" }] },
		} };`);

		const config = await loadConfig(file);
		assert.equal(config.sites[0].group, "a");
		assert.equal(config.sites[0].groupName, "Alpha");
		assert.deepEqual(config.sites[0].groupNames, ["Alpha", "Beta"]);
	});

	test("rejects a membership naming a group that does not exist", async () => {
		// A typo would otherwise make the site quietly vanish from every table.
		const file = configFile(`export default { groups: {
			a: { name: "A", sites: [{ url: "https://x.example/", groups: ["typo"] }] },
		} };`);

		await assert.rejects(() => loadConfig(file), /not defined/);
	});

	test("merges previousUrls declared on either listing", async () => {
		const file = configFile(`export default { groups: {
			a: { name: "A", sites: [{ url: "https://x.example/", previousUrls: ["https://old-a.example/"] }] },
			b: { name: "B", sites: [{ url: "https://x.example/", previousUrls: ["https://old-b.example/"] }] },
		} };`);

		const config = await loadConfig(file);
		assert.equal(config.sites[0].previousUrls.length, 2);
	});

	test("inherits a rate limit from whichever group declares one", async () => {
		const file = configFile(`export default { groups: {
			a: { name: "A", sites: [{ url: "https://x.example/" }] },
			b: { name: "B", rateLimit: { delayMs: 3000 }, sites: [{ url: "https://x.example/" }] },
		} };`);

		const config = await loadConfig(file);
		assert.equal(config.sites[0].rateLimit.delayMs, 3000);
	});
});

describe("selectSites with multi-group membership", () => {
	const build = () =>
		configFile(`export default { groups: {
			a: { name: "A", sites: [{ url: "https://both.example/" }, { url: "https://only-a.example/" }] },
			b: { name: "B", sites: [{ url: "https://both.example/" }, { url: "https://only-b.example/" }] },
		} };`);

	test("matches any membership, not just the primary", async () => {
		const config = await loadConfig(build());
		const inB = selectSites(config.sites, { group: "b" }).map((s) => s.url);

		assert.ok(inB.includes("https://both.example/"), "primary group is 'a' but it belongs to 'b' too");
		assert.ok(inB.includes("https://only-b.example/"));
		assert.equal(inB.length, 2);
	});

	test("selecting both groups returns the shared site once", async () => {
		const config = await loadConfig(build());
		const both = selectSites(config.sites, { group: "a,b" });

		assert.equal(both.filter((s) => s.url === "https://both.example/").length, 1, "measured once, not twice");
		assert.equal(both.length, 3);
	});
});
