export default {
	title: "speedlify2",
	tagline: "Web performance, measured over time",
	description:
		"Lighthouse lab metrics and Chrome UX Report field data for a list of sites, recorded on every run and compared over time.",
	// Set to your deployed origin for absolute URLs in metadata.
	url: process.env.SPEEDLIFY_SITE_URL || "",
	repo: process.env.SPEEDLIFY_REPO_URL || "",

	// Favicon service for the site list. `{url}` is replaced with the
	// encoded site URL. Set to "" for a build that makes no external requests
	// at all — which is arguably the right default for a tool that measures
	// third-party weight for a living.
	avatarService: "https://v1.indieweb-avatar.11ty.dev/{url}/",
};
