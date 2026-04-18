import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createAppStore } from "./store.ts";

export function getRouter(history: RouterHistory) {
	const queryClient = new QueryClient();
	const appStore = createAppStore();

	return createRouter({
		routeTree,
		history,
		context: {
			queryClient,
			appStore,
		},
		Wrap: ({children}) =>
			createElement(QueryClientProvider, {client: queryClient}, children),
	});
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}
