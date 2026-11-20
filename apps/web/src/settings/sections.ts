import {
	ArchiveIcon,
	ChatTextIcon,
	CpuIcon,
	CubeIcon,
	DesktopTowerIcon,
	DevicesIcon,
	HardDrivesIcon,
	type Icon,
	KeyboardIcon,
	PaletteIcon,
	PlugsConnectedIcon,
	PuzzlePieceIcon,
	SlidersHorizontalIcon,
	SparkleIcon,
	StackIcon,
	UserIcon,
} from "@phosphor-icons/react";

/** Whether a path is a settings page: the app's own, or the account's and workspace's under a workspace. */
export const isSettingsPath = (pathname: string) =>
	pathname.startsWith("/settings") || /^\/workspaces\/[^/]+\/settings(\/|$)/.test(pathname);

export interface SettingsSection {
	readonly to:
		| "/workspaces/$workspaceId/settings/account/profile"
		| "/settings/general"
		| "/settings/tabs"
		| "/settings/themes"
		| "/settings/servers"
		| "/settings/paired"
		| "/settings/keybindings"
		| "/settings/models"
		| "/settings/chat"
		| "/settings/mcp"
		| "/settings/skills"
		| "/settings/plugins"
		| "/workspaces/$workspaceId/settings/machines"
		| "/settings/sandboxes"
		| "/settings/archive";
	readonly label: string;
	readonly icon: Icon;
	/** Sidebar heading the section sits under. */
	readonly group: "Personal" | "Application" | "Workspaces";
	/** Extra words the search matches, beyond the label. */
	readonly keywords: readonly string[];
}

const sections: readonly SettingsSection[] = [
	{
		to: "/workspaces/$workspaceId/settings/account/profile",
		label: "Profile",
		icon: UserIcon,
		group: "Personal",
		keywords: ["account", "name", "email", "picture", "photo", "avatar"],
	},
	{
		to: "/settings/general",
		label: "General",
		icon: SlidersHorizontalIcon,
		group: "Application",
		keywords: ["notifications", "sounds", "alerts", "quick", "composer", "editor", "terminal", "version", "updates"],
	},
	{
		to: "/settings/tabs",
		label: "Tabs",
		icon: StackIcon,
		group: "Application",
		keywords: ["tabs", "shortcuts", "reorder", "rename", "delete"],
	},
	{
		to: "/settings/themes",
		label: "Themes",
		icon: PaletteIcon,
		group: "Application",
		keywords: ["appearance", "colors", "dark", "light"],
	},
	{
		to: "/settings/servers",
		label: "Providers",
		icon: HardDrivesIcon,
		group: "Application",
		keywords: ["servers", "provider", "local", "remote", "cli", "service", "install", "codework", "version", "rpc"],
	},
	{
		to: "/settings/paired",
		label: "Paired Machines",
		icon: DevicesIcon,
		group: "Application",
		keywords: ["pair", "paired", "remote", "machine", "code", "ssh", "address", "label"],
	},
	{
		to: "/settings/keybindings",
		label: "Keybindings",
		icon: KeyboardIcon,
		group: "Application",
		keywords: ["shortcuts", "hotkeys", "keyboard", "bindings", "keys", "palette"],
	},
	{
		to: "/settings/models",
		label: "Models",
		icon: CpuIcon,
		group: "Application",
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
		icon: ChatTextIcon,
		group: "Application",
		keywords: ["transcript", "composer", "prompt", "steer", "queue", "follow-up", "usage", "tokens", "games"],
	},
	{
		to: "/settings/mcp",
		label: "MCP",
		icon: PlugsConnectedIcon,
		group: "Application",
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
		icon: SparkleIcon,
		group: "Application",
		keywords: ["skills", "skill.md", "instructions", "workflows", "project", "personal"],
	},
	{
		to: "/settings/plugins",
		label: "Plugins",
		icon: PuzzlePieceIcon,
		group: "Application",
		keywords: ["plugins", "extensions", "npm", "tools", "prompt", "bash", "grep", "find", "reload"],
	},
	{
		to: "/workspaces/$workspaceId/settings/machines",
		label: "Machines",
		icon: DesktopTowerIcon,
		group: "Workspaces",
		keywords: [
			"machines",
			"connect",
			"online",
			"offline",
			"rename",
			"name",
			"relay",
			"harness",
			"computer",
			"setup",
			"set up",
			"install",
			"cli",
			"server",
			"paired",
		],
	},
	{
		to: "/settings/sandboxes",
		label: "Sandboxes",
		icon: CubeIcon,
		group: "Application",
		keywords: ["sandboxes", "worktrees", "git", "branch", "vercel", "daytona", "memory", "isolation"],
	},
	{
		to: "/settings/archive",
		label: "Archive",
		icon: ArchiveIcon,
		group: "Application",
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
