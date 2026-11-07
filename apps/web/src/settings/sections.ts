import {
	Archive,
	Box,
	CloudConnection,
	Cpu,
	Keyboard,
	MessageSquare,
	Palette,
	Puzzle,
	Server,
	SlidersHorizontal,
	Sparkles,
	WorkspaceIcon,
	type IconComponent,
} from "@/components/vuesax";

export interface SettingsSection {
	readonly to:
		| "/settings/general"
		| "/settings/workspaces"
		| "/settings/themes"
		| "/settings/servers"
		| "/settings/keybindings"
		| "/settings/models"
		| "/settings/chat"
		| "/settings/mcp"
		| "/settings/skills"
		| "/settings/plugins"
		| "/settings/sandboxes"
		| "/settings/archive";
	readonly label: string;
	readonly icon: IconComponent;
	/** Sidebar heading the section sits under. */
	readonly group: string;
	/** Extra words the search matches, beyond the label. */
	readonly keywords: readonly string[];
}

const sections: readonly SettingsSection[] = [
	{
		to: "/settings/general",
		label: "General",
		icon: SlidersHorizontal,
		group: "App",
		keywords: ["notifications", "sounds", "alerts", "quick", "composer", "editor", "terminal", "version", "updates"],
	},
	{
		to: "/settings/workspaces",
		label: "Workspaces",
		icon: WorkspaceIcon,
		group: "App",
		keywords: ["tabs", "shortcuts", "reorder", "rename", "delete"],
	},
	{
		to: "/settings/themes",
		label: "Themes",
		icon: Palette,
		group: "App",
		keywords: ["appearance", "colors", "dark", "light"],
	},
	{
		to: "/settings/servers",
		label: "Providers",
		icon: Server,
		group: "App",
		keywords: ["servers", "provider", "local", "remote", "cli", "service", "install", "codework", "version", "rpc"],
	},
	{
		to: "/settings/keybindings",
		label: "Keybindings",
		icon: Keyboard,
		group: "App",
		keywords: ["shortcuts", "hotkeys", "keyboard", "bindings", "keys", "palette"],
	},
	{
		to: "/settings/models",
		label: "Models",
		icon: Cpu,
		group: "Agents",
		keywords: [
			"accounts",
			"oauth",
			"codex",
			"copilot",
			"anthropic",
			"openai",
			"gemini",
			"openrouter",
			"thinking",
			"retry",
			"cache",
		],
	},
	{
		to: "/settings/chat",
		label: "Chat",
		icon: MessageSquare,
		group: "Agents",
		keywords: ["transcript", "composer", "prompt", "steer", "queue", "follow-up", "usage", "tokens", "games"],
	},
	{
		to: "/settings/mcp",
		label: "MCP",
		icon: CloudConnection,
		group: "Agents",
		keywords: [
			"mcp",
			"tools",
			"servers",
			"stdio",
			"http",
			"oauth",
			"exposure",
			"deferred",
			"toolsearch",
			"resources",
		],
	},
	{
		to: "/settings/skills",
		label: "Skills",
		icon: Sparkles,
		group: "Agents",
		keywords: ["skills", "skill.md", "instructions", "workflows", "project", "personal"],
	},
	{
		to: "/settings/plugins",
		label: "Plugins",
		icon: Puzzle,
		group: "Agents",
		keywords: ["plugins", "extensions", "npm", "tools", "prompt", "bash", "grep", "find", "reload"],
	},
	{
		to: "/settings/sandboxes",
		label: "Sandboxes",
		icon: Box,
		group: "Workspace",
		keywords: ["sandboxes", "worktrees", "git", "branch", "vercel", "daytona", "memory", "isolation"],
	},
	{
		to: "/settings/archive",
		label: "Archive",
		icon: Archive,
		group: "Workspace",
		keywords: ["archived", "restore", "unarchive", "sessions", "projects", "hidden"],
	},
];

/** Sections whose label or keywords contain every word of the query, in sidebar order. */
export function search(query: string): readonly SettingsSection[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return sections.filter((section) => {
		const text = [section.label, ...section.keywords].join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}
