import { createFileRoute } from "@tanstack/react-router";

import { WorkspacesSettings } from "../settings/workspaces";

export const Route = createFileRoute("/_shell/settings/workspaces")({ component: WorkspacesSettings });
