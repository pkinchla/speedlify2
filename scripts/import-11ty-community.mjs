#!/usr/bin/env node
/**
 * Import the sites listed in https://github.com/11ty/11ty-community.
 *
 * Writes `config/11ty-community.json`, which `config/sites.js` reads. Re-run it
 * whenever the community list changes; the file is generated, not hand-edited.
 *
 *   node scripts/import-11ty-community.mjs
 *   COMMUNITY_REPO=owner/name node scripts/import-11ty-community.mjs
 *
 * The repository stores one JSON file per submission under `built-with-eleventy/`,
 * each carrying a `url` alongside the submitter's details. Only the URL is read:
 * these are other people's sites and the rest is not ours to republish.
 *
 * `disabled: true` is the one other field that matters. It is upstream saying a
 * submission should not be used — the list's own maintainers, on their own
 * data — so those are skipped rather than measured.
 *
 * The whole tree arrives as a single tarball rather than ~1,300 contents API
 * calls, so a re-import is one request and needs no authentication.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { normalizeUrl, urlHash } from "../lib/hash.js";

const REPO = process.env.COMMUNITY_REPO || "11ty/11ty-community";
const REF = process.env.COMMUNITY_REF || "main";
const DIR = process.env.COMMUNITY_DIR || "built-with-eleventy";
const OUT = process.env.COMMUNITY_OUT || "config/11ty-community.json";

/**
 * Fetch the repository tarball and hand back the directory it extracted to.
 *
 * Uses the codeload URL rather than the API so no token is needed, and untars
 * into a temporary directory that is always cleaned up.
 */
function fetchTree() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "11ty-community-"));
	const tarball = path.join(tmp, "repo.tar.gz");

	const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}`;
	execFileSync("curl", ["-fsSL", "-o", tarball, url], { stdio: ["ignore", "ignore", "inherit"] });

	execFileSync("tar", ["-xzf", tarball, "-C", tmp], { stdio: ["ignore", "ignore", "inherit"] });

	// GitHub wraps the tree in a `<repo>-<ref>` directory whose name we do not
	// want to guess at.
	const root = fs
		.readdirSync(tmp, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(tmp, e.name))[0];

	if (!root) throw new Error(`Nothing extracted from ${url}`);

	return { tmp, entries: path.join(root, DIR) };
}

let tmp;
let entriesDir;

try {
	({ tmp, entries: entriesDir } = fetchTree());
} catch (error) {
	process.stderr.write(`\n  Could not fetch ${REPO}: ${error.message}\n\n`);
	process.exit(1);
}

if (!fs.existsSync(entriesDir)) {
	fs.rmSync(tmp, { recursive: true, force: true });
	process.stderr.write(`\n  ${REPO} has no ${DIR}/ directory — has its layout changed?\n\n`);
	process.exit(1);
}

const files = fs.readdirSync(entriesDir).filter((f) => f.endsWith(".json"));

const seen = new Set();
const urls = [];
const skipped = { invalid: 0, duplicate: 0, nonHttp: 0, unreadable: 0, noUrl: 0, disabled: 0 };

for (let file of files.sort()) {
	let entry;
	try {
		entry = JSON.parse(fs.readFileSync(path.join(entriesDir, file), "utf8"));
	} catch {
		skipped.unreadable++;
		continue;
	}

	if (!entry?.url || !String(entry.url).trim()) {
		skipped.noUrl++;
		continue;
	}

	// Upstream has switched this submission off. Honoured rather than
	// second-guessed, the same way the starters importer honours
	// `excludedFromLeaderboards`: it is the list's maintainers saying this entry
	// should not be used, on their own data.
	if (entry.disabled) {
		skipped.disabled++;
		continue;
	}

	let url;
	try {
		url = new URL(String(entry.url).trim());
	} catch {
		skipped.invalid++;
		continue;
	}

	// Nothing Lighthouse can load.
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		skipped.nonHttp++;
		continue;
	}

	const normalized = normalizeUrl(url.toString());

	// One site can be submitted more than once, and a site already tracked in
	// another category is merged by config/sites.js rather than measured twice.
	if (seen.has(normalized)) {
		skipped.duplicate++;
		continue;
	}

	seen.add(normalized);
	urls.push(normalized);
}

fs.rmSync(tmp, { recursive: true, force: true });

if (!urls.length) {
	process.stderr.write(`\n  Found no usable URLs in ${REPO}/${DIR} — refusing to write an empty list.\n\n`);
	process.exit(1);
}

urls.sort();

/**
 * What this import changes relative to the last one.
 *
 * The list is rewritten from upstream rather than merged, so a submission
 * deleted there disappears from here — which is the intent, but it is also how
 * a site silently stops being measured and leaves its history orphaned. Read
 * the previous file before overwriting it so the run can say what it dropped.
 */
const previous = fs.existsSync(OUT)
	? (() => {
			try {
				return new Set((JSON.parse(fs.readFileSync(OUT, "utf8")).urls || []).map(normalizeUrl));
			} catch {
				// A corrupt or hand-edited file should not stop the import; it only
				// costs this run its comparison.
				return null;
			}
		})()
	: null;

const current = new Set(urls);
const removed = previous ? [...previous].filter((u) => !current.has(u)).sort() : [];
const added = previous ? urls.filter((u) => !previous.has(u)) : [];

// A removed URL tracked in another category keeps being measured; one that is
// not goes dark, and its stored measurements become orphans.
const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
const removedWithHistory = removed.filter((u) => fs.existsSync(path.join(RESULTS_DIR, urlHash(u))));

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(
	OUT,
	JSON.stringify(
		{
			generated: new Date().toISOString(),
			source: `https://github.com/${REPO}`,
			note: "Generated by scripts/import-11ty-community.mjs — do not edit by hand.",
			entries: files.length,
			urls,
		},
		null,
		2,
	) + "\n",
);

const hosts = new Set(urls.map((u) => new URL(u).hostname));

process.stdout.write(
	`\n  wrote ${OUT}\n` +
		`  ${urls.length.toLocaleString()} URLs across ${hosts.size.toLocaleString()} hosts, from ${files.length.toLocaleString()} submissions\n` +
		`  skipped: ${skipped.disabled} disabled upstream, ${skipped.duplicate} duplicate, ` +
		`${skipped.invalid} unparseable, ${skipped.nonHttp} non-HTTP, ` +
		`${skipped.noUrl} without a url, ${skipped.unreadable} unreadable\n` +
		(previous === null
			? `  no previous list to compare against\n`
			: `  changes: +${added.length} added, -${removed.length} removed\n`) +
		"\n",
);

if (removed.length) {
	process.stdout.write(`  REMOVED UPSTREAM — ${removed.length}\n`);
	for (let url of removed) {
		const orphans = removedWithHistory.includes(url);
		process.stdout.write(`    ${url}${orphans ? "   [has stored history]" : ""}\n`);
	}
	process.stdout.write("\n");

	if (removedWithHistory.length) {
		process.stdout.write(
			`  ${removedWithHistory.length} of these have measurements on disk. Any that are not\n` +
				`  listed in another category have stopped being measured, and their history\n` +
				`  is now orphaned — \`speedlify report\` will list it.\n\n`,
		);
	}
}

if (added.length) {
	process.stdout.write(`  ADDED — ${added.length}\n`);
	for (let url of added.slice(0, 25)) process.stdout.write(`    ${url}\n`);
	if (added.length > 25) process.stdout.write(`    …and ${added.length - 25} more\n`);
	process.stdout.write("\n");
}
