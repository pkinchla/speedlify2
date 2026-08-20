import { createHash } from "node:crypto";

/**
 * Stable short id for a URL. This is the directory name a site's history lives
 * in, so it must never change for a given URL — do not "improve" this function
 * without migrating `results/`.
 */
export function urlHash(url) {
	return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

/**
 * Trailing-slash and case differences shouldn't fork a site's history.
 *
 * `https://x.com/en` and `https://x.com/en/` are one site. Servers almost
 * universally serve both and redirect one to the other, so tracking them apart
 * means two histories, two rows that read identically, and that person's server
 * measured twice for the same page.
 *
 * The root path keeps its slash — `https://x.com/` is the canonical form of an
 * origin, and stripping it would re-key every site rather than the handful with
 * a deeper path.
 *
 * Which form the site itself prefers is not lost: measurement follows the
 * redirect, so the page measured is the canonical one, and `canonicalUrl` on
 * the report entry says which it turned out to be.
 */
export function normalizeUrl(url) {
	try {
		const u = new URL(url);
		u.hash = "";
		u.hostname = u.hostname.toLowerCase();
		if (u.pathname === "") u.pathname = "/";
		if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
		return u.toString();
	} catch {
		return String(url).trim();
	}
}

/**
 * The URL as you'd say it out loud: no scheme, no `www.`, no trailing slash.
 *
 *   https://www.11ty.dev/            -> 11ty.dev
 *   https://developer.mozilla.org/en-US/ -> developer.mozilla.org/en-US
 *
 * Used as the display name throughout the site. Note that stripping `www.`
 * can make two separately-tracked URLs read the same — `distinctUrls()` below
 * detects that and backs off rather than showing duplicates.
 */
export function friendlyUrl(url, { stripWww = true } = {}) {
	try {
		const u = new URL(url);
		const host = stripWww ? u.hostname.replace(/^www\./, "") : u.hostname;
		const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
		return `${host}${pathname}${u.search}`;
	} catch {
		return String(url);
	}
}

/**
 * Friendly names for a set of URLs, keeping them distinguishable.
 *
 * If two URLs would collapse to the same friendly form — the classic case being
 * `www.example.com` and `example.com`, which are separate histories — both fall
 * back to keeping the `www.` so the list never shows two identical rows.
 */
export function distinctUrls(urls) {
	const stripped = new Map();
	for (let url of urls) {
		const name = friendlyUrl(url);
		if (!stripped.has(name)) stripped.set(name, []);
		stripped.get(name).push(url);
	}

	const out = new Map();
	for (let [name, group] of stripped) {
		if (group.length === 1) {
			out.set(group[0], name);
		} else {
			for (let url of group) out.set(url, friendlyUrl(url, { stripWww: false }));
		}
	}

	return out;
}

/**
 * The hash the original Speedlify names its API files with.
 *
 * djb2 "times 33" with xor, seeded 5381 and walked backwards, as the `short-hash`
 * package computes it. Reimplemented rather than depended on because it is
 * twelve lines and the dependency is unmaintained.
 *
 * This exists purely so `<speedlify-score>` components already deployed against
 * a Speedlify instance keep working: their documented usage hardcodes this hash
 * in the markup, so the filename is a contract with pages we do not control.
 *
 * Verified against the value published in that component's own README:
 * `https://www.zachleat.com/` -> `bbfa43c1`.
 */
export function shortHash(url) {
	let hash = 5381;
	let i = url.length;
	while (i) hash = (hash * 33) ^ url.charCodeAt(--i);
	return (hash >>> 0).toString(16);
}

/** Filesystem-safe ISO timestamp, sortable as a filename. */
export function stamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}
