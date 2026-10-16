import { FolderKanban } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "@codeworksh/widget/view";
import { Projects } from "./projects";

/** Every project with its sessions; picking a session opens it beside the list. */
export const projects = defineWidget({
	kind: "codework:projects",
	title: "Projects",
	icon: FolderKanban,
	minWidth: 240,
	minHeight: 200,
	cardinality: "one",
	priority: "builtin",
	props: Schema.Struct({}),
	component: Projects,
});
