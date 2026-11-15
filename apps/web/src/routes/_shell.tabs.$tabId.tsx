import { createFileRoute } from "@tanstack/react-router";

/**
 * `open` asks the tab to show an address (a session) once it is on screen; the shell then
 * drops it from the URL. `mode=new` opens it in a new frame rather than reusing one.
 */
interface TabSearch {
	readonly open?: string;
	readonly mode?: "new";
}

// The root Shell renders the tab; an unknown id falls back to the first one.
export const Route = createFileRoute("/_shell/tabs/$tabId")({
	validateSearch: (search: Record<string, unknown>): TabSearch => ({
		...(typeof search.open === "string" ? { open: search.open } : {}),
		...(search.mode === "new" ? { mode: "new" as const } : {}),
	}),
});
