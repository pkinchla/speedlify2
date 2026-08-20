#!/usr/bin/env node
/**
 * Delete stored data for URLs that are no longer in the config.
 *
 * Removing a URL from `config/sites.js` normally *keeps* its history — that is
 * deliberate, so an accidental edit does not destroy months of measurements,
 * and the home page lists it as "orphaned" instead.
 *
 * This script is the opposite intent, for when a URL should be gone: excluding
 * a contact tagged Problematic means their site should leave no trace, not sit
 * in `results/` as an orphan.
 *
 * Deletes, for each orphaned URL:
 *   - every stored measurement
 *   - series.json, meta.json, field-history.json
 *   - any learned redirect alias mentioning the URL
 *
 *   node scripts/purge-excluded.mjs --dry-run   # show what would go
 *   node scripts/purge-excluded.mjs             # delete it
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { ResultStore } from "../lib/store.js";
import { readAliases, writeAliases } from "../lib/aliases.js";
import { normalizeUrl } from "../lib/hash.js";

const { values: flags } = parseArgs({
	options: { "dry-run": { type: "boolean" }, yes: { type: "boolean" } },
	strict: false,
});

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
const dryRun = Boolean(flags["dry-run"]);

const config = await loadConfig();
const store = new ResultStore(RESULTS_DIR);

// Every URL the config still knows about, including predecessors that a
// confirmed site move folded into a current entry.
const configured = new Set();
for (let site of config.sites) {
	configured.add(site.url);
	for (let previous of site.previousUrls) configured.add(previous);
}

const { aliases } = readAliases(RESULTS_DIR);
for (let alias of aliases) {
	// An alias whose destination is still configured is load-bearing: it is what
	// carries the old URL's history forward. Keep its source.
	if (configured.has(normalizeUrl(alias.to))) configured.add(normalizeUrl(alias.from));
}

const doomed = [];

for (let hash of store.hashes()) {
	const dir = path.join(RESULTS_DIR, hash);
	const metaFile = path.join(dir, "meta.json");

	let url = null;
	if (fs.existsSync(metaFile)) {
		try {
			url = normalizeUrl(JSON.parse(fs.readFileSync(metaFile, "utf8")).url || "");
		} catch {
			// Unreadable meta: fall through and treat as unidentifiable.
		}
	}

	if (url && configured.has(url)) continue;

	const files = fs.readdirSync(dir);
	const measurements = files.filter((f) => /^\d{4}-/.test(f)).length;
	const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);

	doomed.push({ hash, dir, url, measurements, files: files.length, bytes });
}

if (!doomed.length) {
	process.stdout.write("\n  Nothing to purge — every stored history belongs to a configured URL.\n\n");
	process.exit(0);
}

const totalBytes = doomed.reduce((s, d) => s + d.bytes, 0);
const totalFiles = doomed.reduce((s, d) => s + d.files, 0);

process.stdout.write(`\n  ${dryRun ? "Would delete" : "Deleting"} ${doomed.length} stored histor${doomed.length === 1 ? "y" : "ies"}:\n\n`);
for (let d of doomed) {
	process.stdout.write(
		`    ${d.hash}  ${String(d.measurements).padStart(3)} measurement(s)  ${String((d.bytes / 1024).toFixed(0)).padStart(5)} kB  ${d.url || "(no meta.json)"}\n`
	);
}
process.stdout.write(`\n    total: ${totalFiles} files, ${(totalBytes / 1024).toFixed(0)} kB\n`);

if (dryRun) {
	process.stdout.write("\n  Dry run — nothing deleted. Re-run without --dry-run to proceed.\n\n");
	process.exit(0);
}

for (let d of doomed) fs.rmSync(d.dir, { recursive: true, force: true });

// Drop learned aliases that pointed at anything just removed, so they cannot
// resurrect the URL by merging it into some other site later.
const purgedUrls = new Set(doomed.map((d) => d.url).filter(Boolean));
const keptAliases = aliases.filter(
	(a) => !purgedUrls.has(normalizeUrl(a.from)) && !purgedUrls.has(normalizeUrl(a.to))
);

if (keptAliases.length !== aliases.length) {
	writeAliases(RESULTS_DIR, keptAliases);
	process.stdout.write(`  removed ${aliases.length - keptAliases.length} redirect alias(es)\n`);
}

process.stdout.write(`\n  Purged. Re-run \`npm run report\` to rebuild.\n\n`);
