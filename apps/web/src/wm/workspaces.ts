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

/** The lowest workspace in a tag mask: where an instance on several workspaces is revealed. */
export const firstWorkspace = (tags: number) => Math.log2(tags & -tags) + 1;

/** Router target for a workspace; the default one is `/`. */
export const workspaceRoute = (id: number) =>
	id === defaultWorkspace
		? ({ to: "/" } as const)
		: ({ to: "/workspaces/$workspaceId", params: { workspaceId: String(id) } } as const);
