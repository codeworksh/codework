import { createFileRoute } from "@tanstack/react-router";

import { ThemesSettings } from "../settings/themes";

export const Route = createFileRoute("/_shell/settings/themes")({ component: ThemesSettings });
