import { defineWidget } from "@codeworksh/widget/view";
import { Schema } from "effect";
import { MessageSquare } from "lucide-react";

import { Session } from "./view";

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
	ownsTab: true,
	replaceable: true,
	props: Schema.Struct({}),
	component: Session,
});
