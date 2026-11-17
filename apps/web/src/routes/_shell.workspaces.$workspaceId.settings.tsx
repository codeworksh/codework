import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "../settings/layout";

// The account's and the workspace's settings, beside the app's own under /settings.
export const Route = createFileRoute("/_shell/workspaces/$workspaceId/settings")({ component: SettingsLayout });
