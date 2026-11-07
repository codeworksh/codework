import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../settings/skills";

export const Route = createFileRoute("/_shell/settings/skills")({ component: SkillsSettings });
