import { createRootRoute } from "@tanstack/react-router";

import { Shell } from "../desktop/shell";

export const Route = createRootRoute({
	component: Shell,
});
