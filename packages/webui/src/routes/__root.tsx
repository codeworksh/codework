import { type QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient;
}>()({
	component: RootLayout,
});

function RootLayout() {
	return (
		<main className="h-screen w-screen overflow-hidden">
			<Outlet />
		</main>
	);
}
