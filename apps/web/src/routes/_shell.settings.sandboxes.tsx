import { createFileRoute } from "@tanstack/react-router";

import { SandboxesSettings } from "../settings/sandboxes";

export const Route = createFileRoute("/_shell/settings/sandboxes")({ component: SandboxesSettings });
