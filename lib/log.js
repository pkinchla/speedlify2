import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR = {
	debug: "\x1b[2m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
	reset: "\x1b[0m",
	dim: "\x1b[2m",
};

/**
 * Run logger. Every measurement writes a machine-readable NDJSON log next to
 * the results so a failed nightly run can be diagnosed after the fact, plus a
 * one-line summary appended to `logs/runs.ndjson` for a quick history of runs.
 *
 * The console output is a side effect; the file is the record.
 */
export class RunLogger {
	constructor({ dir, runId, level = "info", quiet = false }) {
		this.dir = dir;
		this.runId = runId;
		this.level = LEVELS[level] ?? LEVELS.info;
		this.quiet = quiet;
		this.counts = { debug: 0, info: 0, warn: 0, error: 0 };
		this.startedAt = Date.now();

		fs.mkdirSync(dir, { recursive: true });
		this.file = path.join(dir, `${runId}.ndjson`);
		this.stream = fs.createWriteStream(this.file, { flags: "a" });
	}

	#write(level, message, data) {
		this.counts[level]++;
		const entry = {
			ts: new Date().toISOString(),
			runId: this.runId,
			level,
			message,
			...(data !== undefined ? { data } : {}),
		};
		this.stream.write(JSON.stringify(entry) + "\n");

		if (this.quiet || LEVELS[level] < this.level) return;

		const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1).padStart(6);
		const tag = level.toUpperCase().padEnd(5);
		const suffix = data && level !== "info" ? ` ${COLOR.dim}${short(data)}${COLOR.reset}` : "";
		process.stdout.write(
			`${COLOR.dim}${elapsed}s${COLOR.reset} ${COLOR[level]}${tag}${COLOR.reset} ${message}${suffix}\n`
		);
	}

	debug(message, data) { this.#write("debug", message, data); }
	info(message, data) { this.#write("info", message, data); }
	warn(message, data) { this.#write("warn", message, data); }
	error(message, data) { this.#write("error", message, data); }

	/** Append a summary line to the rolling run history and close the stream. */
	async close(summary) {
		const record = {
			runId: this.runId,
			startedAt: new Date(this.startedAt).toISOString(),
			finishedAt: new Date().toISOString(),
			durationMs: Date.now() - this.startedAt,
			counts: this.counts,
			logFile: path.relative(process.cwd(), this.file),
			...summary,
		};

		fs.appendFileSync(path.join(this.dir, "runs.ndjson"), JSON.stringify(record) + "\n");
		this.#write("info", "run complete", undefined);

		await new Promise((resolve) => this.stream.end(resolve));
		return record;
	}
}

function short(data) {
	const s = typeof data === "string" ? data : JSON.stringify(data);
	return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

/** Read the rolling run history, newest first. */
export function readRunHistory(dir, limit = 100) {
	const file = path.join(dir, "runs.ndjson");
	if (!fs.existsSync(file)) return [];

	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.reverse()
		.slice(0, limit);
}
