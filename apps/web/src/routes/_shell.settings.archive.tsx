import { createFileRoute } from "@tanstack/react-router";

import { ArchiveSettings } from "../settings/archive";

export const Route = createFileRoute("/_shell/settings/archive")({ component: ArchiveSettings });
