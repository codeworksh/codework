import { Layers, type LucideIcon } from "lucide-react";

export interface SettingsSection {
	readonly to: "/settings/workspaces";
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
		keywords: ["tabs", "shortcuts", "reorder", "rename", "icon", "delete"],
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
