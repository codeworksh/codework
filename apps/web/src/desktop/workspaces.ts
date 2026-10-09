import { Code2, LayoutDashboard, NotebookPen, type LucideIcon } from "lucide-react";
import { tagBit } from "webwm";

export interface Workspace {
	/** 1-based, as shown in the URL and bound to Cmd/Ctrl+number. */
	readonly id: number;
	readonly name: string;
	readonly icon: LucideIcon;
}

export const workspaces: readonly Workspace[] = [
	{ id: 1, name: "Main", icon: LayoutDashboard },
	{ id: 2, name: "Code", icon: Code2 },
	{ id: 3, name: "Notes", icon: NotebookPen },
];

export const defaultWorkspace = 1;

/** Workspace N is webwm tag bit N-1. */
export const workspaceTag = (id: number) => tagBit(id - 1);

export function parseWorkspace(param: string | undefined): number | null {
	if (param === undefined) return defaultWorkspace;
	const id = Number(param);
	return workspaces.some((workspace) => workspace.id === id) ? id : null;
}
