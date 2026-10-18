import { FolderKanban } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "@codeworksh/widget/view";
import { Projects } from "./projects";

/** What opens the Projects widget, from the command palette. */
export const projectsAddress = "codework://projects";

/** Every project with its sessions; picking a session opens it beside the list. */
export const projects = defineWidget({
	kind: "codework:projects",
	title: "Projects",
	icon: FolderKanban,
	minWidth: 240,
	minHeight: 200,
	cardinality: "one",
	priority: "builtin",
	opens: [projectsAddress],
	props: Schema.Struct({}),
	component: Projects,
});
