import { ChatsIcon } from "@phosphor-icons/react";
import { Schema } from "effect";

import { defineWidget } from "@codeworksh/widget/view";
import { AllThreads } from "./threads";

/** What opens Threads, from the command palette. */
const threadsAddress = "codework://threads";

/** Every thread of the organization as a Linear-like list; picking one opens it beside the list. */
export const threads = defineWidget({
	kind: "codework:threads",
	title: "Threads",
	icon: ChatsIcon,
	minWidth: 360,
	minHeight: 200,
	cardinality: "one",
	priority: "builtin",
	opens: [threadsAddress],
	props: Schema.Struct({}),
	component: AllThreads,
});
