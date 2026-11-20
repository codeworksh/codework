import { createFileRoute } from "@tanstack/react-router";

import { PairedMachine } from "../settings/paired/machine";

export const Route = createFileRoute("/_shell/settings/paired/$id")({ component: Page });

function Page() {
	const { id } = Route.useParams();
	return <PairedMachine key={id} id={id} />;
}
