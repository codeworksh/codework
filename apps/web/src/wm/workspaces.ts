import { useAtomValue } from "@effect/atom-react";
import type { Workspace } from "@codeworksh/server/contract";
import { AsyncResult } from "effect/reactivity";
import { tagBit } from "webwm";

import { Server } from "../kernel/rpc";

export type { Workspace };

/** Every mutation names this key, so the list refetches after any change. */
export const workspacesKey = ["workspaces"];

export const workspacesAtom = Server.query("workspaces.list", undefined, { reactivityKeys: workspacesKey });

export const createWorkspace = Server.mutation("workspaces.create");
export const updateWorkspace = Server.mutation("workspaces.update");
export const reorderWorkspaces = Server.mutation("workspaces.reorder");
export const deleteWorkspace = Server.mutation("workspaces.delete");

/** Workspaces in switcher order; empty until the server answers. */
export function useWorkspaces(): readonly Workspace[] {
	const result = useAtomValue(workspacesAtom);
	return AsyncResult.isSuccess(result) ? result.value : [];
}

/** webwm tag mask for the widgets shown on a workspace. */
export const workspaceTag = (workspace: Workspace) => tagBit(workspace.bit);

export const workspaceRoute = (workspace: Workspace) =>
	({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } }) as const;
