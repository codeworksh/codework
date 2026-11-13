import { ChatTextIcon } from "@phosphor-icons/react";
import { defineWidget } from "@codeworksh/widget/view";
import { Schema } from "effect";

import { Session } from "./view";

/** One thread's conversation: `codework://session/<id>` for a session's main thread, `…/<id>/<thread>` for another. */
export const session = defineWidget({
	kind: "codework:session",
	title: "Session",
	icon: ChatTextIcon,
	minWidth: 280,
	minHeight: 200,
	cardinality: "many",
	priority: "builtin",
	opens: ["codework://session/*", "codework://session/*/*"],
	ownsTab: true,
	replaceable: true,
	props: Schema.Struct({}),
	component: Session,
});
