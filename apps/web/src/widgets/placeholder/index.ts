import { AppWindow } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "../../sdk";

/** An empty frame, standing in for widgets that are not built yet. */
export const placeholder = defineWidget({
	kind: "codework:placeholder",
	title: "Widget",
	icon: AppWindow,
	minWidth: 220,
	minHeight: 140,
	cardinality: "many",
	props: Schema.Struct({}),
	component: () => null,
});
