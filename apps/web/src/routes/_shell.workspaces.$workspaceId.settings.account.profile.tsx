import { createFileRoute } from "@tanstack/react-router";

import { ProfileSettings } from "../settings/profile";

export const Route = createFileRoute("/_shell/workspaces/$workspaceId/settings/account/profile")({
	component: ProfileSettings,
});
