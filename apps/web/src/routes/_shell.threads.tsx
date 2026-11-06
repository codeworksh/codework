import { createFileRoute } from "@tanstack/react-router";

import { ThreadsPage } from "../widgets/threads/page";

export const Route = createFileRoute("/_shell/threads")({ component: ThreadsPage });
