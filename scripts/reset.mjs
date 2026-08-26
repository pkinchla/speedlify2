#!/usr/bin/env node
/**
 * Empty a copy of this project so it can be someone else's instance.
 *
 * The repository is the dataset — `results/` is committed on purpose, because
 * measurement and publishing are separate workflows on separate checkouts and
 * version control is the only channel between them. That design is right for a
 * running instance and wrong for a starting one: a new copy arrives carrying
 * tens of megabytes of another project's measurements and a site list naming
 * more than a thousand URLs its owner never chose.
 *
 * This removes exactly that, and nothing else. The code, the workflows and the
 * templates are what someone came for.
 *
 * Git history is deliberately not touched. A GitHub fork always carries the
 * full history and there is no flag that changes it — the clean start comes
 * from "Use this template", which produces a repository with a single commit.
 * Rewriting history from inside the tree would be a worse version of a button
 * that already exists.
 *
 *   node scripts/reset.mjs           ask, then do it
 *   node scripts/reset.mjs --dry-run show what would happen, change nothing
 *   node scripts/reset.mjs --yes     skip the question, for scripting
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run") || argv.has("-n");
const assumeYes = argv.has("--yes") || argv.has("-y");

const rel = (p) => path.relative(root, p) || ".";
const exists = (p) => fs.existsSync(p);

/** Every file under a directory, for counting and for reporting size. */
function walk(dir) {
	const out = [];
	if (!exists(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

const bytes = (n) =>
	n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} kB` : `${(n / 1e6).toFixed(1)} MB`;

const sizeOf = (files) => files.reduce((sum, f) => sum + fs.statSync(f).size, 0);

/*
 * The plan, built before anything is touched so it can be shown in full and
 * refused in full. Each step reports what it would do; `run` does it.
 */
const steps = [];

// --- Measurements ------------------------------------------------------
{
	const dir = path.join(root, "results");
	const files = walk(dir).filter((f) => path.basename(f) !== ".gitkeep");
	if (files.length) {
		steps.push({
			label: `delete ${files.length} measurement files in ${rel(dir)}/ (${bytes(sizeOf(files))})`,
			run: () => {
				fs.rmSync(dir, { recursive: true, force: true });
				fs.mkdirSync(dir, { recursive: true });
				// Git does not track directories, and the store expects the path to
				// exist rather than creating it on the first write.
				fs.writeFileSync(path.join(dir, ".gitkeep"), "");
			},
		});
	}
}

// --- Logs --------------------------------------------------------------
{
	const dir = path.join(root, "logs");
	const files = walk(dir).filter((f) => {
		if (f.endsWith(".gitkeep")) return false;
		// The empty runs.ndjson this leaves behind is the resting state, not
		// something for a second run to find and offer to delete again.
		return !(path.basename(f) === "runs.ndjson" && fs.statSync(f).size === 0);
	});
	if (files.length) {
		steps.push({
			label: `delete ${files.length} log file(s) in ${rel(dir)}/ (${bytes(sizeOf(files))}), keeping an empty runs.ndjson`,
			run: () => {
				for (const f of files) fs.rmSync(f, { force: true });
				fs.mkdirSync(dir, { recursive: true });
				// readRunHistory opens this unconditionally; an absent file is an
				// error where an empty one is simply no runs yet.
				fs.writeFileSync(path.join(dir, "runs.ndjson"), "");
			},
		});
	}
}

// --- The site list -----------------------------------------------------
{
	const target = path.join(root, "config", "sites.js");
	const example = path.join(root, "config", "sites.example.js");
	const already =
		exists(target) && exists(example) && fs.readFileSync(target, "utf8") === fs.readFileSync(example, "utf8");

	if (exists(example) && !already) {
		steps.push({
			label: `replace ${rel(target)} with ${rel(example)} (3 sites, 1 category)`,
			run: () => fs.copyFileSync(example, target),
		});
	}
}

// --- Imported lists, all specific to the upstream instance --------------
{
	const lists = ["11ty-community.json", "11ty-starters.json", "11ty-emeritus.json", "archived.json", "pinned.json"]
		.map((f) => path.join(root, "config", f))
		.filter(exists);

	if (lists.length) {
		const count = lists.reduce((n, f) => {
			try {
				const d = JSON.parse(fs.readFileSync(f, "utf8"));
				return n + (Array.isArray(d) ? d.length : (d.urls?.length ?? Object.keys(d).length));
			} catch {
				return n;
			}
		}, 0);
		steps.push({
			label: `delete ${lists.length} imported list(s) in config/ — ${count} URLs that belong to the upstream instance`,
			run: () => lists.forEach((f) => fs.rmSync(f, { force: true })),
		});
	}
}

/*
 * The compatibility data for the original Speedlify's API — a frozen list of
 * URLs that instance published, so an old `<speedlify-score>` embed pointing
 * here still resolves. A new instance served none of them, so there is nothing
 * for it to be compatible with.
 *
 * lib/report.js reads this at runtime and treats its absence as an empty list,
 * and the tests that assert on it skip when it is gone, so the routes simply
 * stop being emitted. The two templates under src/api- stay: they are what the
 * component falls back to, and with no URLs they publish an empty index.
 */
{
	const file = path.join(root, "config", "legacy-api-urls.json");
	if (exists(file)) {
		let count = 0;
		try {
			count = JSON.parse(fs.readFileSync(file, "utf8")).urls?.length ?? 0;
		} catch {
			count = 0;
		}
		steps.push({
			label: `delete ${rel(file)} — ${count} URLs from the original instance's API, meaningless here`,
			run: () => fs.rmSync(file, { force: true }),
		});
	}
}

// --- The importers that produced them ----------------------------------// --- The importers that produced them ----------------------------------
{
	const importers = fs
		.readdirSync(path.join(root, "scripts"))
		.filter((f) => f.startsWith("import-"))
		.map((f) => path.join(root, "scripts", f));

	if (importers.length) {
		steps.push({
			label: `delete ${importers.length} importer script(s) — ${importers.map((f) => path.basename(f)).join(", ")}`,
			run: () => importers.forEach((f) => fs.rmSync(f, { force: true })),
		});
	}
}

// --- The priority queue ------------------------------------------------
{
	const file = path.join(root, "config", "priority.txt");
	if (exists(file)) {
		const text = fs.readFileSync(file, "utf8");
		const queued = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
		if (queued) {
			steps.push({
				label: `clear ${queued} queued URL(s) from ${rel(file)}, keeping the instructions at the top`,
				run: () => {
					const kept = text.split("\n").filter((l) => !l.trim() || l.trim().startsWith("#"));
					fs.writeFileSync(file, kept.join("\n").replace(/\n+$/, "\n"));
				},
			});
		}
	}
}

// --- The built report --------------------------------------------------
{
	const file = path.join(root, "report.json");
	if (exists(file)) {
		steps.push({
			label: `delete ${rel(file)} (${bytes(fs.statSync(file).size)}) — regenerated by \`npm run report\``,
			run: () => fs.rmSync(file, { force: true }),
		});
	}
}

// --- Say what will happen, then ask ------------------------------------
if (!steps.length) {
	console.log("\nNothing to reset — this copy is already clean.\n");
	process.exit(0);
}

console.log(`\n  Reset ${rel(root)} to a fresh instance\n`);
for (const step of steps) console.log(`    · ${step.label}`);
console.log(`
  Not touched: git history, the workflows, src/, lib/, or anything else.
  A clean history comes from "Use this template" on GitHub, not from here.
`);

if (dryRun) {
	console.log("  --dry-run: nothing was changed.\n");
	process.exit(0);
}

if (!assumeYes) {
	if (!process.stdin.isTTY) {
		console.error("  Refusing to reset without a terminal to confirm at. Pass --yes if you mean it.\n");
		process.exit(1);
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	// A typed word rather than y/N: this deletes a dataset that cannot be
	// recovered from anywhere but version control, and the whole point of the
	// prompt is that it cannot be answered by reflex.
	const answer = await rl.question("  Type 'reset' to proceed, anything else to stop: ");
	rl.close();

	if (answer.trim().toLowerCase() !== "reset") {
		console.log("\n  Stopped. Nothing was changed.\n");
		process.exit(1);
	}
}

console.log();
for (const step of steps) {
	step.run();
	console.log(`  done: ${step.label}`);
}

console.log(`
  Ready. Next:

    1. Edit config/sites.js — it currently measures three example sites.
    2. Set SPEEDLIFY_SITE_URL and SPEEDLIFY_REPO_URL, or edit src/_data/meta.js.
    3. npm run measure && npm run report && npm run build
`);
