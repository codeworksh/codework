import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import type { OpenMode } from "../sdk";
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

/**
 * Opens an address from outside the desktop (the start page), picking its workspace:
 * 1. where it is already open (the frame looked at last),
 * 2. else the last-used workspace if it shows nothing,
 * 3. else a new auto workspace named `name` while fewer than nine exist,
 * 4. else the last-used workspace.
 * The workspace then opens it (see the route's `open` search); `mode` "new" asks for a new frame.
 */
export function useOpenElsewhere() {
	const workspaces = useWorkspaces();
	const { instances, order } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastWorkspaceAtom);
	const create = useCreateWorkspace();
	const navigate = useNavigate();

	return async (address: string, name: string, mode: OpenMode) => {
		const go = (workspace: Workspace) => navigate(openInWorkspaceRoute(workspace, address, mode));
		const shows = (workspace: Workspace) =>
			instances.filter((instance) => (instance.tags & workspaceTag(workspace)) !== 0);

		const recent = order.focusOrder.flatMap((id) => instances.find((instance) => instance.id === id) ?? []);
		const open = recent.find((instance) => instance.address === address);
		const home = open && workspaces.find((workspace) => (open.tags & workspaceTag(workspace)) !== 0);
		if (home !== undefined) return go(home);

		const last = workspaces.find((workspace) => workspace.id === lastId) ?? workspaces[0];
		if (last !== undefined && shows(last).length === 0) return go(last);

		if (workspaces.length < MAX_WORKSPACES) {
			const created = await create({ name, icon: "messages-square", auto: true }).catch(() => undefined);
			if (created !== undefined) return go(created);
		}
		if (last !== undefined) return go(last);
	};
}
