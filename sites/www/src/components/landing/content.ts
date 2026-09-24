/**
 * Landing page copy. Everything marked as a placeholder is waiting on real messaging;
 * the layout is final, the words are not.
 */

export const GITHUB_URL = "https://github.com/codeworksh/codework";

export const nav = [
	{ label: "Docs", href: "/docs/" },
	{ label: "Changelog", href: "#" },
	{ label: "Blog", href: "#" },
] as const;

export const hero = {
	callout: { text: "Adds support for ACP, agent client protocol", href: "#" },
	title: "Make Code Work for You",
	lines: [
		"An open source coding agent that makes shipping great software fun.",
		"Extend it with plugins of tools, prompts, skills & more, shared via npm or git.",
	],
	primary: { label: "Get started", href: "/docs/" },
	secondary: { label: "View on GitHub", href: GITHUB_URL },
};

export const about = {
	lead: "An agent harness that ",
	// The typewriter cycles through these, backspacing only as far as the next one differs.
	phrases: [
		"has hundreds of models.",
		"steers rather than terminates.",
		"is minimal, yet extensible.",
		"supports sandboxed fs & shell.",
		"works with ChatGPT Plus/Pro.",
		"works with GitHub Copilot.",
		"is not bloated.",
	],
	paragraphs: [
		"Intro paragraph placeholder. Describe the problem CodeWork solves and who it is for, in two or three sentences.",
		"Second paragraph placeholder. Describe the approach: what CodeWork picks for you, and what stays in your hands.",
		"Third paragraph placeholder, pointing to the principles or docs behind it all.",
	],
};

export const showcase = {
	title: "See it in action",
	description: "Placeholder: demo videos and walkthroughs will live here.",
	items: ["Video placeholder", "Video placeholder", "Video placeholder", "Video placeholder"],
};

export const start = {
	title: "Get started",
	description: "Placeholder: how to install CodeWork and run your first task.",
	cards: [
		{ title: "Install placeholder", body: "One or two sentences about the quickest way in.", cta: "Read the guide" },
		{
			title: "Second path placeholder",
			body: "One or two sentences about the alternative way in.",
			cta: "Learn more",
		},
	],
};

export const features = {
	title: "Feature section placeholder",
	description: "Placeholder: one sentence that frames the three features below.",
	cards: [
		{ title: "Feature one", body: "Placeholder description of the first feature." },
		{ title: "Feature two", body: "Placeholder description of the second feature." },
		{ title: "Feature three", body: "Placeholder description of the third feature." },
	],
};

export const community = {
	title: "Get involved with CodeWork",
	description: "Placeholder: an invitation to contribute and follow along.",
	cards: [
		{
			title: "GitHub",
			body: "File issues, fix bugs, and submit features.",
			cta: "Contribute on GitHub",
			href: GITHUB_URL,
		},
		{ title: "Docs", body: "Placeholder: what the docs cover.", cta: "Read the docs", href: "/docs/" },
		{ title: "Community placeholder", body: "Placeholder: where people hang out.", cta: "Join", href: "#" },
		{ title: "Updates placeholder", body: "Placeholder: how to follow releases.", cta: "Follow", href: "#" },
	],
};

export const footer = {
	tagline: "Tagline placeholder for CodeWork.",
	columns: [
		{
			title: "Explore",
			links: [
				{ label: "Docs", href: "/docs/" },
				{ label: "Changelog", href: "#" },
				{ label: "Blog", href: "#" },
			],
		},
		{
			title: "Project",
			links: [
				{ label: "GitHub", href: GITHUB_URL },
				{ label: "License", href: `${GITHUB_URL}/blob/main/LICENSE` },
			],
		},
	],
};
