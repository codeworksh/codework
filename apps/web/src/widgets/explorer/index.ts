import { FolderTree } from "lucide-react";
import { Schema } from "effect";

import { defineWidget } from "../../sdk";
import { Explorer, type ExplorerProps } from "./explorer";

export const explorer = defineWidget<ExplorerProps>({
	kind: "codework:explorer",
	title: "Files",
	icon: FolderTree,
	minWidth: 260,
	minHeight: 200,
	cardinality: "many",
	props: Schema.Struct({ root: Schema.String }),
	component: Explorer,
});
