import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
	return createRouter({
		routeTree,
		history,
		defaultPreload: "intent",
	});
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}
