import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
	return createRouter({
		routeTree,
		history,
		context: {},
		// Route components are split chunks (autoCodeSplitting in vite.config);
		// fetching them on hover/focus intent hides the load.
		defaultPreload: "intent",
	});
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}
