import { createFileRoute } from "@tanstack/react-router";

import { Desktop } from "../desktop";

export const Route = createFileRoute("/")({
	component: Desktop,
});
