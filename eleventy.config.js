import { HtmlBasePlugin } from "@awesome.me/buildawesome";

// Must stay first: loads .env before the data files read process.env.
import "./lib/env.js";

import fs from "node:fs";
import path from "node:path";

import * as simpleIcons from "simple-icons";
import { lowerIsBetter } from "./lib/compare.js";
import { scoreBand, axeBand, cwvBand } from "./lib/rank.js";

const ICONS_DIR = "src/icons";

/**
 * Brand marks kept in the repo rather than pulled from simple-icons.
 *
 * simple-icons is the source for everything it carries, but it does not carry
 * every brand — Amazon's marks were removed from the project at Amazon's
 * request, so `Amazon` and `CloudFront` have to be supplied locally or go
 * without. Drop a square-viewBox, single-path SVG in `src/icons/<Name>.svg`
 * and any host or generator with `icon: "<Name>"` picks it up.
 *
 * The brand colour is read from `data-hex="RRGGBB"` on the root `<svg>` if
 * present; otherwise the mark follows the theme's text colour, which is what
 * the luminance guard below would do for a black mark anyway.
 */
function loadLocalIcons(dir = ICONS_DIR) {
	const icons = {};
	if (!fs.existsSync(dir)) return icons;

	for (let file of fs.readdirSync(dir)) {
		if (!file.endsWith(".svg")) continue;
		const svg = fs.readFileSync(path.join(dir, file), "utf8");
		const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
		if (!paths.length) {
			console.warn(`[speedlify] ${dir}/${file} has no <path d="…"> — skipped`);
			continue;
		}
		if (paths.length > 1) {
			console.warn(`[speedlify] ${dir}/${file} has ${paths.length} paths — only the first is used`);
		}
		icons[path.basename(file, ".svg")] = {
			path: paths[0],
			hex: svg.match(/data-hex="#?([0-9a-f]{6})"/i)?.[1] ?? "000000",
			viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 24 24",
		};
	}

	return icons;
}

const localIcons = loadLocalIcons();

export default async function ($config) {
	$config.addPlugin(HtmlBasePlugin, {
		baseHref: process.env.GITHUB_ACTIONS ? "speedlify2" : "/",
	});

	$config.addPassthroughCopy({ "src/css": "css" });
	$config.addPassthroughCopy({ "src/js": "js" });

	// Brand marks are inlined into the pages that use them, so the directory
	// itself is a source of build inputs rather than output — and its README
	// would otherwise render as a page.
	$config.ignores.add(`${ICONS_DIR}/**`);

	// The report is deliberately NOT published. It is the build's input, not an
	// artifact for the site — and at full coverage it is tens of megabytes, which
	// is not something to serve by accident. The per-site files under
	// /api/site/<slug>.json are the ones consumers actually use.
	//
	// The report is the only input; rebuild when it changes.
	$config.addWatchTarget(process.env.SPEEDLIFY_REPORT_FILE || "report.json");

	// 8080 is a busy port on most machines, and this project is often running
	// alongside whatever else is being measured.
	$config.setServerOptions({ port: 2830 });
	$config.setQuietMode(true);

	/* ---------------------------------------------------------------- format */

	$config.addFilter("bytes", (v) => {
		if (typeof v !== "number") return "—";
		if (v < 1024) return `${v} B`;
		if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
		return `${(v / 1024 / 1024).toFixed(2)} MB`;
	});

	$config.addFilter("ms", (v) => {
		if (typeof v !== "number") return "—";
		if (v < 1000) return `${Math.round(v)} ms`;
		return `${(v / 1000).toFixed(2)} s`;
	});

	$config.addFilter("num", (v, places = 0) => {
		if (typeof v !== "number") return "—";
		return v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
	});

	/** Format by declared unit so one template row handles ms, bytes and counts. */
	$config.addFilter("unit", function (v, unit) {
		if (typeof v !== "number") return "—";
		if (unit === "ms") return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
		if (unit === "bytes") {
			if (v < 1024) return `${v} B`;
			if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
			return `${(v / 1024 / 1024).toFixed(2)} MB`;
		}
		// Unitless: CLS needs decimals, counts do not.
		return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(3);
	});

	/**
	 * A timestamp, formatted in UTC and labelled as such.
	 *
	 * The zone is pinned rather than left to the machine. Everything here is
	 * rendered once at build time, so "local" would mean local to whoever ran
	 * the build — the same page reads differently after a CI build than after
	 * one on your laptop, and neither says which. UTC is the one zone that is
	 * the same answer for every reader.
	 */
	$config.addFilter("date", (v, style = "short") => {
		if (!v) return "never";
		const d = new Date(v);
		if (style === "long") {
			// Explicit components, not dateStyle/timeStyle: Intl rejects those in
			// combination with timeZoneName, which is the whole point here.
			return d.toLocaleString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZone: "UTC",
				timeZoneName: "short",
			});
		}
		return d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			timeZone: "UTC",
		});
	});

	/**
	 * Elapsed time as a bare duration: "12m", "5h", "3d".
	 *
	 * No "ago" and no "yesterday" — these sit in a column headed *Updated*,
	 * where the word is redundant and the mixed forms ("yesterday" next to
	 * "5h ago") make a column of values hard to scan. Anywhere the surrounding
	 * sentence needs a word, the template supplies it.
	 */
	$config.addFilter("since", (v) => {
		if (!v) return "never";

		const diff = Date.now() - new Date(v).getTime();
		const minutes = Math.floor(diff / 60000);
		if (minutes < 60) return `${Math.max(1, minutes)}m`;

		const hours = Math.floor(diff / 3600000);
		if (hours < 48) return `${hours}h`;

		return `${Math.floor(diff / 86400000)}d`;
	});

	/* ----------------------------------------------------------------- class */

	/**
	 * Lighthouse's own banding: <50 poor, 50–89 average, 90+ good.
	 *
	 * From lib/rank.js, because the leaderboard now ranks on these bands before
	 * it ranks on points. A local copy of "90" here would be a way for a row to
	 * be ranked as all-green while drawing an amber ring.
	 */
	$config.addFilter("scoreClass", scoreBand);

	$config.addFilter("ratingClass", (r) => {
		if (r === "good") return "good";
		if (r === "needs-improvement") return "average";
		if (r === "poor") return "poor";
		return "none";
	});

	$config.addFilter("deltaClass", (d) => {
		if (!d || d.unchanged || d.better === null) return "flat";
		return d.better ? "better" : "worse";
	});

	$config.addFilter("deltaArrow", (d) => {
		if (!d || d.unchanged) return "→";
		return d.change > 0 ? "↑" : "↓";
	});

	/** Signed, readable change text. */
	$config.addFilter("deltaText", function (d, unit = "") {
		if (!d) return "";
		if (d.unchanged) return "no change";

		const sign = d.change > 0 ? "+" : "-";
		const abs = Math.abs(d.change);

		let value;
		if (unit === "bytes") {
			value = abs < 1024 ? `${sign}${Math.round(abs)} B` : `${sign}${(abs / 1024).toFixed(1)} kB`;
		} else if (unit === "ms") {
			value = `${sign}${Math.round(abs)} ms`;
		} else {
			value = `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(3)}`;
		}

		// A percentage that rounds to 0.0 adds nothing but noise — a 15 byte move
		// on a 3 MB page is not "0%", it's not worth a percentage at all.
		if (d.pct === null || Math.abs(d.pct) < 0.05) return value;

		return `${value} (${d.pct > 0 ? "+" : ""}${d.pct}%)`;
	});

	$config.addFilter("lowerIsBetter", lowerIsBetter);

	/**
	 * Pluralize a noun to match a count.
	 *
	 * `{{ 1 | plural("score") }}` -> "score", `{{ 2 | plural("score") }}` -> "scores".
	 * Pass an explicit plural for irregular nouns: `plural("entry", "entries")`.
	 */
	$config.addFilter("plural", (count, singular, plural) => {
		return count === 1 ? singular : plural || `${singular}s`;
	});

	/**
	 * A redirect-confirmation reason as a sentence.
	 *
	 * `confirmRedirect` returns machine-readable slugs. They read as jargon in a
	 * list — and "not-enough-measurements" repeated a hundred times says nothing
	 * at all about what is actually happening.
	 */
	$config.addFilter("redirectReason", (reason) => {
		return (
			{
				"not-enough-measurements": "Waiting for more measurements",
				unstable: "Destination keeps changing",
				temporary: "Temporary redirect",
				"no-redirect": "No longer redirecting",
			}[reason] || "Not yet confirmed"
		);
	});

	/**
	 * Why a reason means what it means, for the paragraph under each heading.
	 */
	$config.addFilter("redirectExplanation", (reason) => {
		return (
			{
				"not-enough-measurements":
					"A redirect has to lead to the same place on several consecutive runs before history follows it. These have not been measured enough times yet to tell.",
				unstable:
					"The destination has not been consistent across recent runs. That pattern usually means an A/B test or a geo split rather than a move.",
				temporary:
					"A 302, 303 or 307 is the site saying this is a detour, not a move. History stays at the original URL.",
				"no-redirect": "These stopped redirecting before the move could be confirmed.",
			}[reason] || "Still being assessed."
		);
	});

	/** Count and correctly-pluralized noun together: "1 site", "3 sites". */
	$config.addFilter("countOf", (count, singular, plural) => {
		const word = count === 1 ? singular : plural || `${singular}s`;
		return `${(count ?? 0).toLocaleString("en-US")} ${word}`;
	});

	/**
	 * A data key as words. Lighthouse hands back camelCase identifiers, and they
	 * are rendered as labels rather than read as code.
	 *
	 *   styleLayout          -> style layout
	 *   paintCompositeRender -> paint composite render
	 *   parseHTML            -> parse HTML
	 *   third-party          -> third party
	 *
	 * Acronyms are kept whole — the second pass is what stops `parseHTML` from
	 * coming out as "parse H T M L", and the all-caps test is what keeps it from
	 * then being lowercased back to "parse html".
	 *
	 * Display casing is the stylesheet's job, so what lands in the markup is
	 * ordinary words — a copy-paste gives "time to first byte", not the
	 * half-capitalised "time To First Byte" the split leaves behind.
	 */
	$config.addFilter("humanize", (value) => {
		return String(value ?? "")
			.replace(/([a-z\d])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[-_]+/g, " ")
			.trim()
			.split(/\s+/)
			.map((word) => (/^[A-Z\d]+$/.test(word) ? word : word.toLowerCase()))
			.join(" ");
	});

	/** Subject-verb agreement for a count: "1 site **has**", "3 sites **have**". */
	$config.addFilter("verb", (count, singular, plural) => (count === 1 ? singular : plural));

	/* ------------------------------------------------------------- sparkline */

	/**
	 * Inline SVG sparkline, rendered at build time.
	 *
	 * Deliberately not a charting library: the whole point of this project is
	 * static output, and a 40-point trend line does not justify shipping
	 * JavaScript to draw it.
	 */
	$config.addShortcode("sparkline", function (trend, opts = {}) {
		const width = opts.width || 120;
		const height = opts.height || 28;
		const padding = 2;

		const values = trend?.values;
		if (!values?.length) return "";
		if (values.length === 1) {
			return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><circle cx="${width / 2}" cy="${height / 2}" r="2" class="spark-dot"/></svg>`;
		}

		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min || 1;
		const stepX = (width - padding * 2) / (values.length - 1);

		const points = values.map((v, i) => {
			const x = padding + i * stepX;
			// Flip: SVG y grows downward, and we always draw "up" as the larger value.
			const y = height - padding - ((v - min) / range) * (height - padding * 2);
			return [x, y];
		});

		const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
		const area = `${line} L${points[points.length - 1][0].toFixed(1)},${height} L${points[0][0].toFixed(1)},${height} Z`;

		// Color by whether the series moved in the good direction overall.
		const better = trend.sinceFirst?.better;
		const tone = better === null || better === undefined ? "flat" : better ? "better" : "worse";
		const [lastX, lastY] = points[points.length - 1];

		const label = `${trend.label || trend.key}: ${values.length} measurements, ${min} to ${max}`;

		return [
			`<svg class="spark spark-${tone}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`,
			` role="img" aria-label="${escapeAttr(label)}">`,
			`<path class="spark-area" d="${area}"/>`,
			`<path class="spark-line" d="${line}"/>`,
			`<circle class="spark-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2"/>`,
			`</svg>`,
		].join("");
	});

	/**
	 * A score as a ring, rendered at build time.
	 *
	 * Speedlify draws these with a web component that inlines the whole result
	 * as JSON per row. The same picture is a circle with a dash offset, so it
	 * costs one SVG and no JavaScript.
	 *
	 * The geometry is shared with <speedlify-score> — see `static geometry` in
	 * src/js/speedlify-score.js. 37 across with 3 of stroke leaves a 31-unit
	 * hole for 12-unit text, which is the padding the component has always had;
	 * the two draw the same ring, so a badge embedded elsewhere and the ring it
	 * links back to here do not read as two different components.
	 *
	 * `pct` is what fills the arc, and it is not always the value: an axe count
	 * and a Core Web Vitals verdict have no percentage, so they pass 1 and read
	 * as a closed ring whose colour carries the answer. `null` leaves the track
	 * bare, which is how "no data" looks in both renderers.
	 */
	function ring({ band, text, label, pct, size = 37 }) {
		const stroke = 3;
		const r = (size - stroke) / 2;
		const c = size / 2;
		const circumference = 2 * Math.PI * r;
		// Dash the arc to the value, and rotate so it starts at 12 o'clock.
		const dash = `${(circumference * Math.max(0, Math.min(1, pct ?? 0))).toFixed(2)} ${circumference.toFixed(2)}`;

		return [
			`<svg class="ring ring-${band}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"`,
			` role="img" aria-label="${escapeAttr(label)}">`,
			`<circle class="ring-track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"/>`,
			typeof pct === "number"
				? `<circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"` +
					` stroke-dasharray="${dash}" stroke-linecap="round" transform="rotate(-90 ${c} ${c})"/>`
				: "",
			`<text class="ring-text" x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central">`,
			`${escapeAttr(text)}</text>`,
			`</svg>`,
		].join("");
	}

	/** One of the four Lighthouse categories: the arc is the score itself. */
	$config.addShortcode("scoreRing", function (value, label = "", size = 37) {
		return ring({
			band: scoreBand(value),
			text: value ?? "–",
			label: label ? `${label}: ${value ?? "no data"}` : String(value ?? "no data"),
			pct: typeof value === "number" ? value / 100 : null,
			size,
		});
	});

	/**
	 * A violation count short enough to fit inside a ring.
	 *
	 * The only ring value that can outgrow its circle. Lighthouse scores stop at
	 * 100 and Core Web Vitals is a glyph, but axe counts violating *nodes* — one
	 * bad rule on a long table is thousands — and four digits at this size render
	 * 32 units wide in a 31-unit hole, spilling over the stroke and onto the
	 * neighbouring rings, which do not clip because the stroke's round cap needs
	 * overflow visible.
	 *
	 * The exact number stays in the label, so this costs nothing but precision no
	 * one reads off a 12-unit glyph anyway.
	 */
	function shortCount(n) {
		if (n < 1000) return String(n);
		const k = n / 1000;
		if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
		if (k < 99.5) return `${Math.round(k)}k`;
		return "99k+";
	}

	/**
	 * Axe violations. Banded by lib/rank.js, which ranks on these bands before it
	 * ranks on points — a local copy of the thresholds here is how a row ends up
	 * ranked above one it visibly ties with.
	 */
	$config.addShortcode("axeRing", function (axe, size = 37) {
		const value = axe && !axe.error ? axe.violations : null;
		if (typeof value !== "number") {
			return ring({ band: "none", text: "–", label: "Axe: did not run", pct: null, size });
		}

		const rules = axe.violationRules;
		return ring({
			band: axeBand(value),
			text: shortCount(value),
			label:
				`Axe: ${value} violating node${value === 1 ? "" : "s"}` +
				(typeof rules === "number" ? ` across ${rules} rule${rules === 1 ? "" : "s"}` : ""),
			pct: 1,
			size,
		});
	});

	/**
	 * Core Web Vitals, which is a verdict rather than a number.
	 *
	 * A glyph instead of a count, matching the component: the underlying figure
	 * is three separate metrics, and one of them failing is the whole answer as
	 * far as the ranking is concerned. How many, and which, is in the label.
	 */
	$config.addShortcode("cwvRing", function (failures, assessed, size = 37) {
		if (typeof failures !== "number") {
			return ring({
				band: "none",
				text: "–",
				label: "Core Web Vitals: no real-user data — not counted in the ranking",
				pct: null,
				size,
			});
		}

		return ring({
			band: cwvBand(failures),
			text: failures === 0 ? "✓" : "✗",
			label: `Core Web Vitals: ${failures} of ${assessed ?? "?"} failing at p75`,
			pct: 1,
			size,
		});
	});

	/** 🥇🥈🥉 for the top three, nothing for everyone else. */
	$config.addFilter("trophy", (rank) => {
		if (rank === 1) return "🥇";
		if (rank === 2) return "🥈";
		if (rank === 3) return "🥉";
		return "";
	});

	/**
	 * Favicon for a site, via the same avatar service Speedlify uses.
	 *
	 * This is the one external request the built site makes. Set
	 * `meta.avatarService` to "" to drop it and keep the output fully
	 * self-contained — worth considering for a tool that measures page weight.
	 */
	$config.addFilter("avatar", function (url, service) {
		if (!service) return "";
		return service.replace("{url}", encodeURIComponent(url));
	});

	/**
	 * Brand icon for a detected generator or host, as inline SVG.
	 *
	 * Path data comes from simple-icons at build time, so the published page
	 * stays self-contained — no icon font, no sprite sheet, no extra request.
	 * Falls back to a text chip when there is no icon for the brand, which is
	 * common for smaller hosts and one-off generators.
	 *
	 * `src/icons/<Name>.svg` overrides or supplies a mark simple-icons doesn't
	 * carry — Amazon and CloudFront are the notable gaps, their marks having
	 * been removed from the project at Amazon's request.
	 */
	$config.addShortcode("stackIcon", function (detected, size = 16) {
		if (!detected) return "";

		// `detail` is the finer-grained thing behind a bucketed name — the actual
		// daemon behind "Self-hosted". Worth a tooltip, not a column.
		let label = detected.version ? `${detected.name} ${detected.version}` : detected.name;
		if (detected.detail) label += ` · ${detected.detail}`;
		// A presumption is the category's claim, not a measurement. Same glyph so
		// it is recognisable, faded so it never reads as a detection.
		if (detected.presumed) label = `Listed as ${detected.name} — no generator tag found on the page`;
		const presumed = detected.presumed ? " stack-presumed" : "";
		const icon = detected.icon ? (localIcons[detected.icon] ?? simpleIcons[`si${detected.icon}`]) : null;

		if (!icon) {
			// A bucketed row has no mark of its own, but the thing behind it might
			// — nginx and Apache have logos, "Self-hosted" does not. Put that mark
			// inside the chip: the chip still says "this is a bucket", and the mark
			// says which member. Always monochrome, since it is sitting on the
			// chip's own muted background rather than the page.
			const detailIcon = detected.detailIcon
				? (localIcons[detected.detailIcon] ?? simpleIcons[`si${detected.detailIcon}`])
				: null;
			if (detailIcon) {
				return [
					`<span class="stack-chip stack-chip-icon${presumed}" title="${escapeAttr(label)}">`,
					`<svg width="11" height="11" viewBox="${escapeAttr(detailIcon.viewBox ?? "0 0 24 24")}"`,
					` role="img" aria-label="${escapeAttr(label)}" fill="currentColor">`,
					`<title>${escapeAttr(label)}</title>`,
					`<path d="${detailIcon.path}"/>`,
					`</svg></span>`,
				].join("");
			}

			// Nothing to show but a name — initial letters. The detail is what
			// distinguishes one bucketed row from the next, so it names the chip
			// when there is one.
			const chip = (detected.detail ?? detected.name).slice(0, 2);
			return `<span class="stack-chip${presumed}" title="${escapeAttr(label)}">${escapeAttr(chip)}</span>`;
		}

		// Several brands — Vercel, Next.js, GitHub, Eleventy — are pure black, and
		// a black mark on a #2e2e2e page is invisible. Any brand colour too close
		// to either end of the range is dropped in favour of `currentColor`, so
		// the icon follows the theme's text colour instead. Those marks are
		// recognisable by shape, and a visible glyph beats an accurate one.
		const luminance = relativeLuminance(icon.hex);
		const usesBrandColor = luminance > 0.06 && luminance < 0.85;
		const fill = usesBrandColor ? `#${icon.hex}` : "currentColor";

		return [
			`<svg class="stack-icon${usesBrandColor ? "" : " stack-icon-mono"}${presumed}"`,
			` width="${size}" height="${size}" viewBox="${escapeAttr(icon.viewBox ?? "0 0 24 24")}"`,
			` role="img" aria-label="${escapeAttr(label)}" fill="${fill}">`,
			`<title>${escapeAttr(label)}</title>`,
			`<path d="${icon.path}"/>`,
			`</svg>`,
		].join("");
	});

	/** Horizontal proportion bar, used for resource-type and third-party splits. */
	$config.addShortcode("bar", function (value, max, tone = "neutral") {
		if (typeof value !== "number" || !max) return "";
		const pct = Math.max(0, Math.min(100, (value / max) * 100));
		return `<span class="bar bar-${tone}"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span>`;
	});

	/* --------------------------------------------------------------- helpers */

	$config.addFilter("sortByValue", (obj) => {
		if (!obj) return [];
		return Object.entries(obj)
			.filter(([, v]) => typeof v === "number" && v > 0)
			.sort((a, b) => b[1] - a[1])
			.map(([key, value]) => ({ key, value }));
	});

	$config.addFilter("maxValue", (list, key) => {
		const nums = (list || []).map((i) => (key ? i[key] : i)).filter((n) => typeof n === "number");
		return nums.length ? Math.max(...nums) : 0;
	});

	$config.addFilter("keep", (list, key) => (list || []).filter((i) => i && i[key]));

	$config.addFilter("limit", (list, n) => (list || []).slice(0, n));

	$config.addFilter("json", (v) => JSON.stringify(v, null, 2));

	return {
		dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
		markdownTemplateEngine: "njk",
		htmlTemplateEngine: "njk",
	};
}

function escapeAttr(s) {
	return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** WCAG relative luminance for a 6-digit hex colour, 0 (black) to 1 (white). */
function relativeLuminance(hex) {
	const n = Number.parseInt(hex, 16);
	if (!Number.isFinite(n)) return 0.5;

	const channel = (v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};

	const r = channel((n >> 16) & 255);
	const g = channel((n >> 8) & 255);
	const b = channel(n & 255);

	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
