import { createFileRoute } from "@tanstack/react-router";

import { TabsSettings } from "../settings/tabs";

export const Route = createFileRoute("/_shell/settings/tabs")({ component: TabsSettings });
