import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettings } from "../settings/plugins";

export const Route = createFileRoute("/_shell/settings/plugins")({ component: PluginsSettings });
