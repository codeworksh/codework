import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettings } from "../settings/models";

export const Route = createFileRoute("/_shell/settings/models")({ component: ModelsSettings });
