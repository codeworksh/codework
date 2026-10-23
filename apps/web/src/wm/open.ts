import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";

import type { OpenMode } from "@codeworksh/widget/view";
import { deskAtom } from "./instances";
import {
	lastWorkspaceAtom,
	MAX_WORKSPACES,
	openInWorkspaceRoute,
	useCreateWorkspace,
	useWorkspaces,
	type Workspace,
	workspaceTag,
} from "./workspaces";

/** Where to open: in a frame (`OpenMode`), or in a workspace of its own. */
export type Placement = OpenMode | "workspace";

/**
 * Opens an address from outside a frame (the sidebar, the start page), picking its workspace:
 * 1. where it is already open (the frame looked at last), unless a new workspace is asked for,
 * 2. else the workspace on screen,
 * 3. else the last-used workspace if it shows nothing,
 * 4. else a new auto workspace named `name` while fewer than nine exist,
 * 5. else the last-used workspace.
 * A "workspace" placement skips to 4. The workspace then opens it (see the route's `open`
 * search); `mode` "new" asks for a new frame.
 */
export function useOpenElsewhere() {
	const workspaces = useWorkspaces();
	const { instances, order } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastWorkspaceAtom);
	const { workspaceId: currentId } = useParams({ strict: false });
	const create = useCreateWorkspace();
	const navigate = useNavigate();

	return async (address: string, name: string, placement: Placement) => {
		const mode: OpenMode = placement === "workspace" ? "new" : placement;
		const go = (workspace: Workspace) => navigate(openInWorkspaceRoute(workspace, address, mode));
		const shows = (workspace: Workspace) =>
			instances.filter((instance) => (instance.tags & workspaceTag(workspace)) !== 0);
		const last = workspaces.find((workspace) => workspace.id === lastId) ?? workspaces[0];

		if (placement !== "workspace") {
			const recent = order.focusOrder.flatMap((id) => instances.find((instance) => instance.id === id) ?? []);
			const open = recent.find((instance) => instance.address === address);
			const home = open && workspaces.find((workspace) => (open.tags & workspaceTag(workspace)) !== 0);
			if (home !== undefined) return go(home);

			const current = workspaces.find((workspace) => workspace.id === currentId);
			if (current !== undefined) return go(current);

			if (last !== undefined && shows(last).length === 0) return go(last);
		}

		if (workspaces.length < MAX_WORKSPACES) {
			const created = await create({ name, auto: true }).catch(() => undefined);
			if (created !== undefined) return go(created);
		}
		if (last !== undefined) return go(last);
	};
}
