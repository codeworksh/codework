import { Layers, type LucideIcon, Palette, Server } from "lucide-react";

export interface SettingsSection {
	readonly to: "/settings/workspaces" | "/settings/themes" | "/settings/servers";
	readonly label: string;
	readonly icon: LucideIcon;
	/** Sidebar heading the section sits under. */
	readonly group: string;
	/** Extra words the search matches, beyond the label. */
	readonly keywords: readonly string[];
}

export const sections: readonly SettingsSection[] = [
	{
		to: "/settings/workspaces",
		label: "Workspaces",
		icon: Layers,
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
];

/** Sections whose label or keywords contain every word of the query, in sidebar order. */
export function search(query: string): readonly SettingsSection[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return sections.filter((section) => {
		const text = [section.label, ...section.keywords].join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}
