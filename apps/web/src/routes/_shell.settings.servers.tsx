import { createFileRoute } from "@tanstack/react-router";

import { ServersSettings } from "../settings/servers/servers";

export const Route = createFileRoute("/_shell/settings/servers")({ component: ServersSettings });
