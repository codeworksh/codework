import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettings } from "../settings/general";

export const Route = createFileRoute("/_shell/settings/general")({ component: GeneralSettings });
