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
		"An open source coding agent that makes shipping great software fun.",
		"Extend it with plugins like tools, prompts, skills & more, shared via npm or git.",
	],
	install: [
		{ label: "pnpm", command: "pnpm add -g @codeworksh/cli@canary" },
		{ label: "npm", command: "npm install -g @codeworksh/cli@canary" },
		{ label: "bun", command: "bun add -g @codeworksh/cli@canary" },
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
		"steers rather than terminates.",
		"is minimal, yet extensible.",
		"runs in any sandbox.",
		"works with ChatGPT Plus/Pro.",
		"works with GitHub Copilot.",
		"is not bloated.",
	],
	paragraphs: [
		"CodeWork is open source, the way devtools should be. A harness malleable enough to fit how you work, and how your team ships.",
		"CodeWork handles the loop, the sandbox and the models. Everything else is yours to shape: tools, skills, prompts and more, bundled as plugins and shared with your team over npm or git.",
		"Start with the defaults and change them as you go. The docs cover how it's built, and how to make it yours.",
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

export const modes = {
	title: "Use it where you work",
	description: "One agent and one set of sessions, wherever you are.",
	cta: { label: "Read the CLI docs", href: "/docs/cli/" },
	cards: [
		{
			title: "CLI",
			body: "Run a task from your terminal and pick the session up later.",
			command: 'codework run "build me flappy bird"',
			href: "/docs/cli/",
		},
		{
			title: "Editor",
			body: "The agent inside Zed, or any editor that speaks ACP.",
			command: "codework acp",
			href: "/docs/integrations/acp/",
		},
		{
			title: "Server",
			body: "Keep sessions running and drive them from your own tools.",
			command: "codework serve",
			href: "/docs/integrations/rpc/",
		},
	],
	backdrop: "/images/landing/editor.webp",
	soon: [
		{ title: "TUI", body: "A full-screen terminal app for long, hands-on sessions." },
		{ title: "Desktop", body: "Run, watch and review many sessions side by side." },
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
		"Prompt plugins shape the system prompt, like your AGENTS.md.",
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
			drivers: ["local"],
			body: "Your folder and your shell. The default, with full access to your machine.",
		},
		{
			name: "Virtual",
			drivers: ["memory", "sqldb"],
			body: "An in-memory filesystem and an emulated bash. No process ever runs on your machine.",
		},
		{
			name: "Remote",
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
