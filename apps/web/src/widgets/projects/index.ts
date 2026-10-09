import { FolderKanban, MessageSquare } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "../../sdk";
import { Projects } from "./projects";
import { Session } from "./session";

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

/** One session's conversation, opened by its `codework://session/<id>` address. */
export const session = defineWidget({
	kind: "codework:session",
	title: "Session",
	icon: MessageSquare,
	minWidth: 280,
	minHeight: 200,
	cardinality: "many",
	priority: "builtin",
	opens: ["codework://session/*"],
	props: Schema.Struct({}),
	component: Session,
});
