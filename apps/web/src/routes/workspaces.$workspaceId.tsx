import { createFileRoute, redirect } from "@tanstack/react-router";

import { defaultWorkspace, parseWorkspace } from "../wm/workspaces";

// The root Shell renders the workspace; this route only keeps the URL canonical.
export const Route = createFileRoute("/workspaces/$workspaceId")({
	beforeLoad: ({ params }) => {
		const id = parseWorkspace(params.workspaceId);
		if (id === null || id === defaultWorkspace) throw redirect({ to: "/" });
	},
});
