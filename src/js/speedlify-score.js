/**
 * <speedlify-score> — Lighthouse scores for one URL, with a summary on hover.
 *
 * Inspired by https://github.com/zachleat/speedlify-score, with one deliberate
 * difference: there is no `urls.json` index to download. The data file for a
 * URL is found by slugifying the URL in the browser with the same rules the
 * generator uses, so a page needs exactly one request for exactly the data it
 * shows — and no index, no crypto, and no secure context to get it.
 *
 *   <script type="module" src="https://your-speedlify/js/speedlify-score.js"></script>
 *   <speedlify-score speedlify-url="https://your-speedlify/"></speedlify-score>
 *
 * With no `url`, it describes the page it is embedded on.
 *
 *   <speedlify-score speedlify-url="https://your-speedlify/" url="https://example.com/"></speedlify-score>
 *
 * Always renders the same four Lighthouse scores. Everything else about the
 * site is in the tooltip on hover or focus.
 *
 * A site whose slug collided with another is published under its hash instead,
 * and will read here as unmeasured rather than as the wrong site. That is the
 * deliberate trade for a filename a browser can work out on its own.
 */

/**
 * Shared across every instance on the page.
 *
 * Ten components pointing at the same URL should make one request, so both the
 * in-flight promise and the parsed body are cached by URL.
 */
class SpeedlifyStore {
	constructor() {
		this.fetches = new Map();
	}

	static join(base, path) {
		const root = base.endsWith("/") ? base : `${base}/`;
		return root + (path.startsWith("/") ? path.slice(1) : path);
	}

	/**
	 * Normalize exactly as lib/hash.js does — trailing slash, lowercase host,
	 * no fragment. A mismatch here means a 404 rather than a wrong answer,
	 * which is at least loud.
	 */
	static normalizeUrl(url) {
		try {
			const u = new URL(url);
			u.hash = "";
			u.hostname = u.hostname.toLowerCase();
			if (u.pathname === "") u.pathname = "/";
			return u.toString();
		} catch {
			return String(url).trim();
		}
	}

	/**
	 * The published filename for a URL. Must match `siteSlug()` in lib/slug.js
	 * exactly — a drift here is a 404, not a wrong answer, which is at least
	 * loud. There is a test asserting the two agree.
	 *
	 * Host, path and query; scheme dropped, `www.` kept. A literal `-` doubles
	 * so a dash in a path stays distinct from a path boundary, and every
	 * substitution is per-character rather than per-run.
	 */
	static slug(url) {
		let source;
		try {
			const u = new URL(SpeedlifyStore.normalizeUrl(url));
			const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
			source = `${u.hostname}${pathname}${u.search}`;
		} catch {
			source = String(url).trim();
		}

		const slug = source
			.toLowerCase()
			.replace(/-/g, "--")
			.replace(/[^a-z0-9-]/g, "-")
			.slice(0, 180);

		// A URL that substitutes to nothing but separators is published under its
		// hash, which this cannot derive — so ask for a name that will 404 rather
		// than one that might hit another site.
		return /[a-z0-9]/.test(slug) ? slug : "";
	}

	async fetch(apiUrl) {
		if (!this.fetches.has(apiUrl)) {
			this.fetches.set(
				apiUrl,
				fetch(apiUrl).then((response) => {
					if (!response.ok) throw new Error(`${response.status} for ${apiUrl}`);
					return response.json();
				})
			);
		}
		return this.fetches.get(apiUrl);
	}

	async load(speedlifyUrl, { url }) {
		return this.fetch(SpeedlifyStore.join(speedlifyUrl, `api/site/${SpeedlifyStore.slug(url)}.json`));
	}
}

const store = new SpeedlifyStore();

class SpeedlifyScore extends HTMLElement {
	static tagName = "speedlify-score";

	static register(tagName) {
		if (!globalThis.customElements?.get(tagName || SpeedlifyScore.tagName)) {
			customElements.define(tagName || SpeedlifyScore.tagName, SpeedlifyScore);
		}
	}

	static attrs = {
		speedlifyUrl: "speedlify-url",
		url: "url",
	};

	static css = `
:host {
	display: inline-flex;
	align-items: center;
	gap: .4em;
	position: relative;
	font-family: inherit;
	font-size: inherit;
	line-height: 1;
	vertical-align: middle;
}
:host([hidden]) { display: none; }

.score {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	/* Sized for the widest value it ever holds: "100" is three bold tabular
	   digits, roughly 1.8em, so 2.2em left barely a tenth of an em either side
	   and read as cramped. Equal width and height, because a circle that grows
	   to fit its text is an oval. */
	width: 2.6em;
	height: 2.6em;
	border: 2px solid currentColor;
	border-radius: 50%;
	font-size: .75em;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}
/*
 * The placeholder. Same box as a real circle — that is what stops the swap from
 * moving anything — with the value and colour withheld until they are known.
 */
.skeleton {
	color: #888;
	opacity: .45;
	animation: speedlify-pulse 1.4s ease-in-out infinite;
}
@keyframes speedlify-pulse {
	0%, 100% { opacity: .25; }
	50%      { opacity: .6; }
}
@media (prefers-reduced-motion: reduce) {
	.skeleton { animation: none; }
}

.good    { color: #0cce6b; }
.average { color: #ffa400; }
.poor    { color: #ff4e42; }
.none    { color: #888; }

/* The trigger is a button so it is reachable by keyboard, not just hover. */
.trigger {
	all: unset;
	display: inline-flex;
	align-items: center;
	gap: .4em;
	cursor: help;
}
.trigger:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }

.tip {
	position: absolute;
	bottom: calc(100% + .5em);
	left: 0;
	z-index: 20;
	min-width: 15em;
	padding: .6em .75em;
	border-radius: 6px;
	background: #1c1c1c;
	color: #fff;
	font-size: .8rem;
	line-height: 1.45;
	text-align: left;
	box-shadow: 0 4px 16px rgb(0 0 0 / .35);
	opacity: 0;
	visibility: hidden;
	transition: opacity .12s ease;
}
:host(:hover) .tip, .trigger:focus ~ .tip, .tip:hover { opacity: 1; visibility: visible; }
@media (prefers-reduced-motion: reduce) { .tip { transition: none; } }

.tip dl { display: grid; grid-template-columns: auto auto; gap: .15em .75em; margin: .4em 0 0; }
.tip dt { opacity: .65; }
.tip dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.tip .name { font-weight: 700; word-break: break-all; }
.tip .stale { color: #ffa400; }
.tip a { color: #7cc0ff; }
`;

	connectedCallback() {
		if (this.shadowRoot) return;

		this.attachShadow({ mode: "open" });

		// Painted before the fetch starts, at exactly the size the real circles
		// occupy. The data arrives one request later; without this the element is
		// zero-width until then and every score that loads pushes the text around
		// it. Reserving the space is the whole point — the pulse is just so the
		// placeholder reads as loading rather than as six empty results.
		this.renderSkeleton();

		this.init().catch((error) => {
			// A widget that cannot load its data should disappear, not shout on
			// someone else's page. The reason stays available for debugging.
			this.dataset.error = error.message;
			this.hidden = true;
		});
	}

	get speedlifyUrl() {
		const value = this.getAttribute(SpeedlifyScore.attrs.speedlifyUrl);
		if (!value) throw new Error(`<${SpeedlifyScore.tagName}> requires a ${SpeedlifyScore.attrs.speedlifyUrl} attribute`);
		return value;
	}

	renderSkeleton() {
		const style = document.createElement("style");
		style.textContent = SpeedlifyScore.css;

		const wrapper = document.createElement("div");
		wrapper.style.display = "contents";
		// Six, matching render(): four Lighthouse categories, axe, Core Web Vitals.
		// A button, matching render() exactly — `all: unset` normalises most of it,
		// but a span and a button are not guaranteed the same box, and any
		// difference here is the shift this method exists to prevent. Inert while
		// loading: there is nothing to describe yet.
		wrapper.innerHTML =
			`<button class="trigger" type="button" tabindex="-1" aria-hidden="true">` +
			'<span class="score skeleton"></span>'.repeat(6) +
			`</button>`;

		this.setAttribute("aria-busy", "true");
		this.shadowRoot.replaceChildren(style, wrapper);
	}

	async init() {
		const data = await store.load(this.speedlifyUrl, {
			// Default to the page this is embedded on.
			url: this.getAttribute(SpeedlifyScore.attrs.url) || location.href,
		});

		if (!data.measured) {
			this.hidden = true;
			return;
		}

		const style = document.createElement("style");
		style.textContent = SpeedlifyScore.css;

		const wrapper = document.createElement("div");
		wrapper.style.display = "contents";
		wrapper.innerHTML = this.render(data);

		this.shadowRoot.replaceChildren(style, wrapper);
		this.removeAttribute("aria-busy");

		// Escape closes the tooltip for keyboard users.
		this.shadowRoot.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.shadowRoot.querySelector(".trigger")?.blur();
		});
	}

	scoreClass(value) {
		if (typeof value !== "number") return "none";
		if (value >= 90) return "good";
		if (value >= 50) return "average";
		return "poor";
	}

	scoreHtml(label, value) {
		return `<span class="score ${this.scoreClass(value)}" title="${label}">${value ?? "–"}</span>`;
	}

	/**
	 * Axe violations, where the scale runs the other way.
	 *
	 * A Lighthouse score is better when higher; a violation count is better when
	 * zero. Banding it by the same thresholds would paint "2 violations" green
	 * for being a small number, so it gets its own: clean, or not clean.
	 */
	axeHtml(value) {
		if (typeof value !== "number") {
			return `<span class="score none" title="Axe: did not run">–</span>`;
		}
		const band = value === 0 ? "good" : value <= 5 ? "average" : "poor";
		const label = `Axe: ${value} violating node${value === 1 ? "" : "s"}`;
		return `<span class="score ${band}" title="${label}">${value}</span>`;
	}

	/**
	 * Core Web Vitals, which is a verdict rather than a number.
	 *
	 * A glyph instead of a value, because the underlying figure is three
	 * separate metrics and no single number represents them. The tooltip below
	 * carries the detail for anyone who wants it.
	 */
	cwvHtml(cwv) {
		if (!cwv || cwv.pass === null || cwv.pass === undefined) {
			return `<span class="score none" title="Core Web Vitals: no data">–</span>`;
		}
		const source = cwv.source === "field" ? "real users" : "lab approximation";
		const label = `Core Web Vitals: ${cwv.pass ? "pass" : "fail"} (${source})`;
		return `<span class="score ${cwv.pass ? "good" : "poor"}" title="${label}">${cwv.pass ? "✓" : "✗"}</span>`;
	}

	bytes(n) {
		if (typeof n !== "number") return "–";
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
		return `${(n / 1024 / 1024).toFixed(2)} MB`;
	}

	ms(n) {
		if (typeof n !== "number") return "–";
		return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
	}

	since(iso) {
		if (!iso) return "never";
		const diff = Date.now() - new Date(iso).getTime();
		const minutes = Math.floor(diff / 60000);
		if (minutes < 60) return `${Math.max(1, minutes)}m`;
		const hours = Math.floor(diff / 3600000);
		return hours < 48 ? `${hours}h` : `${Math.floor(diff / 86400000)}d`;
	}

	/** The summary shown on hover or focus. */
	tooltip(data) {
		const rows = [];
		const row = (label, value) => value !== null && value !== undefined && rows.push(`<dt>${label}</dt><dd>${value}</dd>`);

		row("Total", `${data.total} / 400`);
		if (data.rank) row("Rank", `#${data.rank}`);
		row("LCP", this.ms(data.metrics?.lcp));
		row("Weight", this.bytes(data.metrics?.weight));
		row("Requests", data.metrics?.requests);
		if (data.axe !== null) row("Axe violations", data.axe);
		if (data.cwv) row("Core Web Vitals", data.cwv.pass === null ? "no data" : data.cwv.pass ? "pass" : "fail");
		if (data.generator) row("Built with", data.generator);
		if (data.host) row("Hosted by", data.host);

		const measured = `<span class="${data.stale ? "stale" : ""}">${this.since(data.updated)} old</span>`;
		const link = `<a href="${SpeedlifyStore.join(this.speedlifyUrl, data.page)}">Full report</a>`;

		return [
			`<span class="tip" role="tooltip" id="tip">`,
			`<span class="name">${data.name}</span><br>`,
			measured,
			`<dl>${rows.join("")}</dl>`,
			`<div style="margin-top:.5em">${link}</div>`,
			`</span>`,
		].join("");
	}

	/**
	 * Six circles: the four Lighthouse scores, axe violations, and Core Web
	 * Vitals.
	 *
	 * There is no configuration here on purpose: every instance of the component
	 * looks the same, so a page carrying several of them reads as one table
	 * rather than as a row of differently-shaped badges.
	 *
	 * These six are the ones the leaderboard ranks by — the four categories,
	 * then axe and Core Web Vitals as its tiebreakers. Total, rank, weight and
	 * requests are all in the tooltip, which costs nothing until asked for.
	 */
	render(data) {
		const parts = [
			this.scoreHtml("Performance", data.lighthouse?.performance),
			this.scoreHtml("Accessibility", data.lighthouse?.accessibility),
			this.scoreHtml("Best Practices", data.lighthouse?.bestPractices),
			this.scoreHtml("SEO", data.lighthouse?.seo),
			// The two the ranking uses as tiebreakers, which Lighthouse's own four
			// do not cover: a full axe run, and real-user Core Web Vitals.
			this.axeHtml(data.axe),
			this.cwvHtml(data.cwv),
		];

		return [
			`<button class="trigger" type="button" aria-describedby="tip">${parts.join("")}</button>`,
			this.tooltip(data),
		].join("");
	}
}

SpeedlifyScore.register();

export { SpeedlifyScore, SpeedlifyStore };
