import { createFileRoute } from "@tanstack/react-router";

import { ThisMachine } from "../settings/machines/local";

// A route of its own, so it wins over a paired machine's `$id`, whose ids are generated and never this.
export const Route = createFileRoute("/_shell/settings/machines/localhost")({ component: ThisMachine });
