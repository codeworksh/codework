import { createFileRoute } from "@tanstack/react-router";

import { PairedList } from "../settings/paired/list";

export const Route = createFileRoute("/_shell/settings/paired/")({ component: PairedList });
