import { KanbanSquare } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "@codeworksh/widget/view";
import { Dashboard } from "./dashboard";

/** What opens the Dashboard widget, from the command palette. */
export const dashboardAddress = "codework://dashboard";

/** Every thread by status, priority or group, in its manual order; picking one opens it beside the board. */
export const dashboard = defineWidget({
	kind: "codework:dashboard",
	title: "Dashboard",
	icon: KanbanSquare,
	minWidth: 320,
	minHeight: 200,
	cardinality: "one",
	priority: "builtin",
	opens: [dashboardAddress],
	props: Schema.Struct({}),
	component: Dashboard,
});
