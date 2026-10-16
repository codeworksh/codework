import { createRootRoute, Outlet } from "@tanstack/react-router";

import { Palette } from "../shell/palette";

export const Route = createRootRoute({
	component: () => (
		<>
			<Outlet />
			<Palette />
		</>
	),
});
