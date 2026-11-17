import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettings } from "../settings/machines";

export const Route = createFileRoute("/_shell/settings/machines")({ component: MachinesSettings });
