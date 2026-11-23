import { DesktopTowerIcon, HardDrivesIcon, type Icon, PaletteIcon, StackIcon, UserIcon } from "@phosphor-icons/react";

/** Whether a path is a settings page: the app's own, or the account's and workspace's under a workspace. */
export const isSettingsPath = (pathname: string) =>
	pathname.startsWith("/settings") || /^\/workspaces\/[^/]+\/settings(\/|$)/.test(pathname);

export interface SettingsSection {
	readonly to:
		| "/workspaces/$workspaceId/settings/account/profile"
		| "/settings/tabs"
		| "/settings/themes"
		| "/settings/servers"
		| "/settings/machines";
	readonly label: string;
	readonly icon: Icon;
	/** Sidebar heading the section sits under. */
	readonly group: "Personal" | "Application";
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
		to: "/settings/machines",
		label: "Machines",
		icon: DesktopTowerIcon,
		group: "Application",
		keywords: [
			"machines",
			"pair",
			"paired",
			"remote",
			"code",
			"ssh",
			"address",
			"label",
			"link",
			"linked",
			"unlink",
			"workspace",
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
		],
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
