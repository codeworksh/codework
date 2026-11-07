import { createFileRoute } from "@tanstack/react-router";

import { McpSettings } from "../settings/mcp";

export const Route = createFileRoute("/_shell/settings/mcp")({ component: McpSettings });
