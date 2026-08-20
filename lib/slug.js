import { urlHash, normalizeUrl } from "./hash.js";

/**
 * Longest slug before it stops being a filename and starts being a problem.
 * Path segments cap at 255 bytes on every filesystem we care about; this leaves
 * room for the `.json` suffix and a wide margin besides.
 */
const MAX_LENGTH = 180;

/**
 * The part of a URL a slug is built from: host, path and query, with the
 * scheme dropped.
 *
 * Dropping the scheme is a deliberate loss — `http://x.com/` and `https://x.com/`
 * are separate records that produce the same slug. Keeping it would make the
 * slug injective but would put `https-` in front of every URL on the site, and
 * `assignSlugs` catches the case rather than paying that everywhere.
 *
 * Unlike `friendlyUrl`, `www.` is kept. Stripping it is the right call for
 * something a person reads, and the wrong one for something that has to
 * identify a record — `www.x.com` and `x.com` are different sites.
 */
function slugSource(url) {
	try {
		const u = new URL(normalizeUrl(url));
		const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
		return `${u.hostname}${pathname}${u.search}`;
	} catch {
		return String(url).trim();
	}
}

/**
 * A path segment identifying one site.
 *
 *   https://www.11ty.dev/                -> www-11ty-dev
 *   https://developer.mozilla.org/en-US/ -> developer-mozilla-org-en-us
 *   https://example.com/a-b              -> example-com-a--b
 *   https://example.com/a/b              -> example-com-a-b
 *
 * Separators are escaped rather than collapsed: a literal `-` in the URL
 * doubles, so a dash in a path and a path boundary stay distinguishable. That
 * is what stops the last two examples above from being the same file.
 *
 * Every substitution is per-character. Collapsing runs would be prettier and
 * would quietly merge `a//b` into `a/b`.
 */
export function siteSlug(url) {
	const slug = slugSource(url)
		.toLowerCase()
		.replace(/-/g, "--")
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, MAX_LENGTH);

	// Nothing usable survived — a URL of only punctuation, or unparseable, which
	// substitutes to a run of separators and reads as nothing at all.
	return /[a-z0-9]/.test(slug) ? slug : urlHash(url);
}

/**
 * Slugs for a set of URLs, guaranteed distinct.
 *
 * The slug is collision-resistant, not collision-proof: the scheme is dropped,
 * case is folded, and anything past 180 characters is cut. Any of those can put
 * two real URLs on one slug.
 *
 * A collision falls back to the hash for every member of the group, and calls
 * `onCollision`. The fallback matters because the slug is also how the embed
 * component finds its data file — it derives the slug from the URL in the
 * browser with no index to consult, so it cannot know a collision happened.
 * Handing the colliding sites a hash means they resolve to a file the component
 * will not ask for, which renders as "not measured" rather than as wrong
 * numbers. The warning is how you find out it happened.
 */
export function assignSlugs(urls, { onCollision } = {}) {
	const groups = new Map();
	// Deduped first: one URL listed twice is one site, not two sites fighting
	// over a name. `loadConfig` already guarantees this, so it is a guard rather
	// than a fix — but the failure it prevents (a site pushed onto a hash for
	// colliding with itself) would be a baffling one to debug.
	for (let url of [...new Set(urls)]) {
		const slug = siteSlug(url);
		if (!groups.has(slug)) groups.set(slug, []);
		groups.get(slug).push(url);
	}

	const out = new Map();
	for (let [slug, group] of groups) {
		if (group.length === 1) {
			out.set(group[0], slug);
			continue;
		}

		onCollision?.(slug, group);
		for (let url of group) out.set(url, urlHash(url));
	}

	return out;
}
