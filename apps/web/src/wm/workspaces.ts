import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Workspace } from "@codeworksh/contract";
import { Atom, AsyncResult } from "effect/reactivity";
import { useContext } from "react";
import { tagBit } from "webwm";

import { runQuery, Server } from "../kernel/rpc";

export type { Workspace };

/** webwm tag bits available, and so the Cmd+1–9 keys; the server enforces it too. */
export const MAX_WORKSPACES = 9;

/** Every mutation names this key, so the list refetches after any change. */
export const workspacesKey = ["workspaces"];

export const workspacesAtom = Server.query("workspaces.list", undefined, { reactivityKeys: workspacesKey });

export const createWorkspace = Server.mutation("workspaces.create");
export const updateWorkspace = Server.mutation("workspaces.update");
export const reorderWorkspaces = Server.mutation("workspaces.reorder");
// Kept alive so a delete started as the desktop unmounts (its last frame closed) still lands.
export const deleteWorkspace = Server.mutation("workspaces.delete").pipe(Atom.keepAlive);

/** Workspaces in switcher order; empty until the server answers. */
export function useWorkspaces(): readonly Workspace[] {
	const result = useAtomValue(workspacesAtom);
	return AsyncResult.isSuccess(result) ? result.value : [];
}

/** webwm tag mask for the widgets shown on a workspace. */
export const workspaceTag = (workspace: Workspace) => tagBit(workspace.bit);

export const workspaceRoute = (workspace: Workspace) =>
	({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } }) as const;

/** The workspace last on screen, for opening things from outside the desktop (the start page). */
export const lastWorkspaceAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/** A workspace route that, once shown, opens `address` there (see the route's `open` search). */
export const openInWorkspaceRoute = (workspace: Workspace, address: string, mode: "replace" | "new") =>
	({
		...workspaceRoute(workspace),
		search: { open: address, ...(mode === "new" ? { mode: "new" as const } : {}) },
	}) as const;

/**
 * Creates a workspace and resolves once the shared list includes it. Going to it before then would
 * find a stale list: the shell shows nothing, or sends an empty-looking app back to the start page.
 */
export function useCreateWorkspace() {
	const registry = useContext(RegistryContext);
	const create = useAtomSet(createWorkspace, { mode: "promise" });
	return async (payload: { readonly name: string; readonly auto?: boolean }) => {
		const workspace = await create({ payload, reactivityKeys: workspacesKey });
		await runQuery(registry, workspacesAtom);
		return workspace;
	};
}
