import { createFileRoute } from "@tanstack/react-router";

import { MetricsPage } from "../metrics/page";

export const Route = createFileRoute("/_shell/metrics")({ component: MetricsPage });
