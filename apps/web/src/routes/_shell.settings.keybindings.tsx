import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettings } from "../settings/keybindings";

export const Route = createFileRoute("/_shell/settings/keybindings")({ component: KeybindingsSettings });
