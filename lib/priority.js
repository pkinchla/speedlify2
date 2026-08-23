import fs from "node:fs";
import { normalizeUrl } from "./hash.js";

/**
 * A queue of URLs to measure next, ahead of whatever is stalest.
 *
 * Measurement is otherwise entirely automatic: each run spends its budget on
 * the sites that have gone longest without one, and there is no way to say "do
 * this one now" short of running the command by hand with `--url`. That is fine
 * from a terminal and no use at all from CI, where the interesting case is
 * usually the opposite — you added a site, or changed one, and want it measured
 * on the next scheduled run rather than in three days' time when it comes round.
 *
 * A plain text file rather than a JSON structure or a CLI subcommand: this is a
 * list of URLs a person types, one per line, and every editor and every
 * `echo >>` already knows how to append to it. Blank lines and `#` comments are
 * ignored, so it can carry a note about why something is queued.
 *
 * Entries are removed once processed — see `dropFromQueue`. The queue is a list
 * of intentions, not a record: a URL that has had its turn should not keep
 * jumping the line on every subsequent run.
 */

/**
 * Read the queue, normalized and deduplicated, newest intent last.
 *
 * Returns an empty list when the file does not exist, which is the ordinary
 * case — the queue is a thing you use occasionally, not a file the project
 * needs in order to run.
 */
export function readQueue(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}

	const seen = new Set();
	const urls = [];

	for (let line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const url = normalizeUrl(trimmed);
		if (seen.has(url)) continue;

		seen.add(url);
		urls.push(url);
	}

	return urls;
}

/**
 * Remove URLs from the queue, leaving everything else exactly as written.
 *
 * Line-based rather than rewriting from the parsed list, so comments, blank
 * lines and the order a person chose all survive a run. A line is dropped only
 * when it normalizes to one of the given URLs — the same comparison `readQueue`
 * makes, so what was matched is what gets removed.
 *
 * Lines that did not correspond to a configured site are left alone. They are
 * the one thing here worth someone's attention, and deleting them would take
 * away the evidence of the typo along with the queue entry.
 *
 * Returns how many lines were removed. Writes nothing when that is zero, so a
 * run that queued nothing leaves no diff to commit.
 */
export function dropFromQueue(file, urls) {
	if (!urls?.length) return 0;

	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return 0;
	}

	const drop = new Set(urls.map(normalizeUrl));
	const lines = text.split("\n");
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return true;
		return !drop.has(normalizeUrl(trimmed));
	});

	const removed = lines.length - kept.length;
	if (!removed) return 0;

	// An emptied queue stays as an empty file rather than being deleted: the
	// file's existence is how someone finds the feature, and a path that appears
	// and disappears is worse to keep in version control than one that is
	// sometimes blank.
	fs.writeFileSync(file, kept.join("\n"));
	return removed;
}
