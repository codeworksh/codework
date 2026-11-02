/**
 * Landing page copy. Everything marked as a placeholder is waiting on real messaging;
 * the layout is final, the words are not.
 */

export const GITHUB_URL = "https://github.com/codeworksh/codework";

export const nav = [
	{ label: "Posts", href: "/posts/" },
	{ label: "Docs", href: "/docs/" },
	{ label: "Changelog", href: "/changelog/" },
] as const;

export const hero = {
	title: "Make Code Work for You",
	lines: [
		"CodeWork is an open source AI coding agent for your terminal, editor or server.",
		"Add tools, prompts, skills and more as plugins, shared over npm or git.",
	],
	install: [
		{ label: "curl", command: "curl -fsSL https://codework.sh/install | sh" },
		{ label: "pnpm", command: "pnpm add -g @codeworksh/cli" },
		{ label: "npm", command: "npm install -g @codeworksh/cli" },
		{ label: "bun", command: "bun add -g @codeworksh/cli" },
	],
	links: [
		{ label: "Read the docs", href: "/docs/quickstart/" },
		{ label: "View on GitHub", href: GITHUB_URL },
	],
};

export const about = {
	lead: "An agent harness that ",
	// The typewriter cycles through these, backspacing only as far as the next one differs.
	phrases: [
		"supports hundreds of models.",
		"you steer instead of restart.",
		"is small, and easy to extend.",
		"runs in any sandbox.",
		"works with ChatGPT Plus/Pro.",
		"works with GitHub Copilot.",
		"is not bloated.",
	],
	paragraphs: [
		"CodeWork is open source, the way dev tools should be. Bend it to fit how you work and how your team ships.",
		"CodeWork runs the agent, the sandbox and the models. Everything else is yours to shape: tools, skills, prompts and more, bundled as plugins and shared with your team over npm or git.",
		"Start with the defaults and change them as you go. The docs cover how it's built and how to make it yours.",
	],
};

export const showcase = {
	title: "See it in action",
	// Reads "devs ♥ it. …", the heart drawn as a pixel glyph between the halves.
	description: ["devs", "it. share yours, it might end up here."],
	// `id` is the YouTube video id.
	videos: [
		{ id: "X6Q-JAGxva4", title: "Codework + ACP: Running an AI Coding Agent Inside Zed", channel: "Prem Patel" },
	],
};

const NIGHTLY = `${GITHUB_URL}/releases/download/nightly`;

export const install = {
	title: "Install CodeWork",
	description: "The CLI runs your agent harness. The desktop app runs many sessions side by side.",
	cta: { label: "Full installation guide", href: "/docs/cli/installation/" },
	cli: {
		title: "CLI",
		body: "One command installs the standalone binary, or add the npm package.",
		note: "The binary runs without Node.js on macOS (Apple silicon) and Linux (x64, ARM64).",
		docs: { label: "Quickstart", href: "/docs/quickstart/" },
	},
	desktop: {
		title: "Desktop",
		channel: "Canary",
		body: "Run many sessions side by side. Fresh builds, so expect a few rough edges.",
		releases: `${GITHUB_URL}/releases/tag/nightly`,
		checksums: `${NIGHTLY}/SHA256SUMS`,
		platforms: [
			{
				name: "macOS (ARM64)",
				detail: "Apple silicon",
				files: [
					{ label: "DMG", href: `${NIGHTLY}/codework-desktop-mac-arm64.dmg` },
					{ label: "ZIP", href: `${NIGHTLY}/codework-desktop-mac-arm64.zip` },
				],
			},
			{
				name: "Linux (x64)",
				detail: "Intel / AMD",
				files: [
					{ label: "AppImage", href: `${NIGHTLY}/codework-desktop-linux-x64.AppImage` },
					{ label: "DEB", href: `${NIGHTLY}/codework-desktop-linux-x64.deb` },
					{ label: "pacman", href: `${NIGHTLY}/codework-desktop-linux-x64.pacman` },
				],
			},
			{
				name: "Linux (ARM64)",
				detail: "ARM64",
				files: [
					{ label: "AppImage", href: `${NIGHTLY}/codework-desktop-linux-arm64.AppImage` },
					{ label: "DEB", href: `${NIGHTLY}/codework-desktop-linux-arm64.deb` },
					{ label: "pacman", href: `${NIGHTLY}/codework-desktop-linux-arm64.pacman` },
				],
			},
		],
	},
};

export const gallery = {
	label: "The desktop app",
	// Each title and line shows with its screenshot.
	screens: [
		{
			title: "All your projects, one place",
			body: "Orchestrate sessions across projects, steer them while they work. Go tokenmaxxing to warm up those GPUs.",
			src: "/images/landing/app/desktop.webp",
			alt: "The CodeWork desktop app with sessions from four projects, one of them writing and running tests.",
		},
		{
			title: "Steer, don't restart",
			body: "Changed your mind halfway? Nudge the agent while it works. No do-overs, no hard feelings.",
			src: "/images/landing/app/steer.webp",
			alt: "A session still working, with a message waiting to steer it.",
		},
		{
			title: "Side by side",
			body: "As many sessions as your screen can fit. Taste one while the rest are still cooking.",
			src: "/images/landing/app/split.webp",
			alt: "Sessions open side by side, one finished and one still working.",
		},
		{
			title: "Bored? Dino's got your back",
			body: "The agent writes your tests, you keep the dino alive. Zero tokens, peak productivity.",
			src: "/images/landing/app/game.webp",
			alt: "The dino game running full screen in the desktop app.",
		},
	],
};

export const models = {
	title: "Any model, including the plan you pay for",
	description:
		"Sign in with a ChatGPT or Copilot subscription, set an API key, or point it at a model on your own machine. Switch per run, per project, or mid-conversation.",
	cta: { label: "Browse the model catalog", href: "/docs/models/catalog/" },
	providers: [
		"ChatGPT",
		"GitHub Copilot",
		"OpenRouter",
		"Anthropic",
		"OpenAI",
		"Gemini",
		"xAI",
		"Ollama",
		"LM Studio",
		"vLLM",
		"Your gateway",
		"and more",
	],
};

export const plugins = {
	title: "Everything is a plugin",
	description:
		"The built-in tools are plugins too. Switch any of them off, or add your own tools and prompt sections from npm, git, or a file in your repo.",
	points: [
		"Tool plugins add or rewrite what the agent can do.",
		"Prompt plugins shape the system prompt, the way AGENTS.md does.",
		"Local TypeScript files load with no build step.",
	],
	cta: { label: "Write a plugin", href: "/docs/plugins/" },
	file: ".codework/settings.jsonc",
	snippet: `{
  "plugins": [
    // Turn on a built-in search tool
    { "plugin": "codework.tool.grep", "enabled": true },
    // Add your own from npm, git, or a local file
    "@acme/codework-tool-proc@1.2.0",
    "github:acme/codework-prompt-style#v1.0.0",
    "./plugins/house-style.ts"
  ]
}`,
};

export const sandbox = {
	title: "One sandbox, wherever it runs",
	description:
		"The agent only sees a filesystem and a shell. The sandbox decides where they live, so the same tools work on your machine, in memory, or in the cloud.",
	command: 'codework run --sandbox-driver memory "summarize data.csv"',
	tiers: [
		{
			name: "Local",
			href: "/docs/sandboxes/local/",
			drivers: ["local"],
			body: "Your folder and your shell. The default, with full access to your machine.",
		},
		{
			name: "Virtual",
			href: "/docs/sandboxes/virtual/",
			drivers: ["memory", "sqldb"],
			body: "An in-memory filesystem and an emulated bash. No process ever runs on your machine.",
		},
		{
			name: "Remote",
			href: "/docs/sandboxes/remote/",
			drivers: ["daytona", "vercel"],
			body: "A full Linux machine in the cloud, for untrusted code and long jobs.",
		},
	],
	note: "CodeWork doesn't ask before it runs commands or edits files. Work in a git repository, or pick a sandbox.",
	cta: { label: "About sandboxes", href: "/docs/sandboxes/" },
};

export const community = {
	title: "Get involved",
	links: [
		{ label: "GitHub", body: "Issues, bugs and pull requests", href: GITHUB_URL },
		{ label: "Docs", body: "How it works and how to change it", href: "/docs/" },
		{ label: "Posts", body: "Announcements and tutorials", href: "/posts/" },
		{ label: "Changelog", body: "What shipped, release by release", href: "/changelog/" },
	],
};

export const footer = {
	tagline: "An open source coding agent that makes shipping great software fun.",
	columns: [
		{
			title: "Explore",
			links: [
				{ label: "Posts", href: "/posts/" },
				{ label: "Docs", href: "/docs/" },
				{ label: "Changelog", href: "/changelog/" },
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
