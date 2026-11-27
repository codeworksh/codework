import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { NotFound, PageError } from "./shell/fault";

export function getRouter(history: RouterHistory) {
	return createRouter({
		routeTree,
		history,
		context: {},
		// Route components are split chunks (autoCodeSplitting in vite.config);
		// fetching them on hover/focus intent hides the load.
		defaultPreload: "intent",
		defaultErrorComponent: PageError,
		defaultNotFoundComponent: NotFound,
	});
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
	interface StaticDataRouteOption {
		/** The page fills the window, without the app's sidebar and title bar. */
		fullWindow?: boolean;
	}
}
