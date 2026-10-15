import { createFileRoute } from "@tanstack/react-router";

import { Shell } from "../shell/shell";

// A pathless layout, so switching workspaces (a URL change) never remounts the Shell.
export const Route = createFileRoute("/_shell")({
	component: Shell,
});
