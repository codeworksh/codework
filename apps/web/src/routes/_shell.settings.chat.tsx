import { createFileRoute } from "@tanstack/react-router";

import { ChatSettings } from "../settings/chat";

export const Route = createFileRoute("/_shell/settings/chat")({ component: ChatSettings });
