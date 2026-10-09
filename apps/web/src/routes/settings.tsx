import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "../settings/layout";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });
