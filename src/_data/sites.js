import fs from "node:fs";
import path from "node:path";

const REPORT_FILE = process.env.SPEEDLIFY_REPORT_FILE || "report.json";

/**
 * The build's single source of truth: the generated report.
 *
 * All of the analysis — trends, rankings, comparisons, coverage — happens in
 * `speedlify report`, not here. This file only loads the result, which means the
 * Eleventy build reads exactly one file, opens no measurements, and cannot
 * mutate anything as a side effect. `npm run build` runs the report step first.
 */
export default function () {
	const file = path.resolve(REPORT_FILE);

	if (!fs.existsSync(file)) {
		throw new Error(
			`No report found at ${REPORT_FILE}.\n\n` +
				`  The site is built from a generated report rather than from the\n` +
				`  measurements directly. Generate it with:\n\n` +
				`      npx speedlify report\n\n` +
				`  or run \`npm run build\`, which does both steps.\n`
		);
	}

	let report;
	try {
		report = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`Could not parse ${REPORT_FILE}: ${err.message}. Re-run \`npx speedlify report\`.`);
	}

	// A report written by a different version of the projection would render
	// with missing fields rather than failing outright, which is harder to
	// diagnose than saying so here.
	if (report.version !== 1) {
		throw new Error(
			`${REPORT_FILE} was written by an incompatible version (found ${report.version}). ` +
				`Re-run \`npx speedlify report\`.`
		);
	}

	return report;
}
