import { defineWidget } from "@codeworksh/widget/view";
import { Schema } from "effect";

import { Changes, ChangesIcon } from "./view";

/** A space's working-tree changes, every file stacked: `codework://changes/<machine id>/<space id>`. */
export const changes = defineWidget({
	kind: "codework:changes",
	title: "Git Changes",
	icon: ChangesIcon,
	minWidth: 320,
	minHeight: 200,
	cardinality: "many",
	priority: "builtin",
	opens: ["codework://changes/*/*"],
	replaceable: true,
	props: Schema.Struct({}),
	component: Changes,
});
