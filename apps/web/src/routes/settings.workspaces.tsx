import { createFileRoute } from "@tanstack/react-router";

import { WorkspacesSettings } from "../settings/workspaces";

export const Route = createFileRoute("/settings/workspaces")({ component: WorkspacesSettings });
