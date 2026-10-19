import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "../settings/layout";

export const Route = createFileRoute("/_shell/settings")({ component: SettingsLayout });
