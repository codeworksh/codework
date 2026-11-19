import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettings } from "../settings/machines";

export const Route = createFileRoute("/_shell/workspaces/$workspaceId/settings/machines")({ component: Page });

function Page() {
	const { workspaceId } = Route.useParams();
	return <MachinesSettings key={workspaceId} workspaceId={workspaceId} />;
}
