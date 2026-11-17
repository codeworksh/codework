import { createFileRoute } from "@tanstack/react-router";

import { Setup } from "../setup";

export const Route = createFileRoute("/workspaces/$workspaceId/settings/machines/setup")({
	staticData: { fullWindow: true },
	component: Page,
});

function Page() {
	const { workspaceId } = Route.useParams();
	return <Setup key={workspaceId} workspaceId={workspaceId} />;
}
