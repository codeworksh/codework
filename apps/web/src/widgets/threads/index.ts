import { ListTodo } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "@codeworksh/widget/view";
import { AllThreads } from "./threads";

/** What opens All Threads, from the command palette. */
export const threadsAddress = "codework://threads";

/** Every thread of the organization as a Linear-like list; picking one opens it beside the list. */
export const threads = defineWidget({
	kind: "codework:threads",
	title: "All Threads",
	icon: ListTodo,
	minWidth: 360,
	minHeight: 200,
	cardinality: "one",
	priority: "builtin",
	opens: [threadsAddress],
	props: Schema.Struct({}),
	component: AllThreads,
});
