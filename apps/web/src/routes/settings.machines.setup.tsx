import { createFileRoute } from "@tanstack/react-router";

import { SetupPage } from "../setup";

export const Route = createFileRoute("/settings/machines/setup")({
	staticData: { fullWindow: true },
	component: SetupPage,
});
