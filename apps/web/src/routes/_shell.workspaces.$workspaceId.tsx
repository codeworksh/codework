import { createFileRoute } from "@tanstack/react-router";

/**
 * `open` asks the workspace to show an address (a session) once it is on screen; the shell then
 * drops it from the URL. `mode=new` opens it in a new frame rather than reusing one.
 */
interface WorkspaceSearch {
	readonly open?: string;
	readonly mode?: "new";
}

// The root Shell renders the workspace; an unknown id falls back to the first one.
export const Route = createFileRoute("/_shell/workspaces/$workspaceId")({
	validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
		...(typeof search.open === "string" ? { open: search.open } : {}),
		...(search.mode === "new" ? { mode: "new" as const } : {}),
	}),
});
