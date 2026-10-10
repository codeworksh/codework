import { defaultPromptPlugin } from "./builtin/prompt/default.ts";
import { instructionPlugin } from "./builtin/prompt/instruction.ts";
import { bashPlugin } from "./builtin/tool/bash.ts";
import { editPlugin } from "./builtin/tool/edit.ts";
import { readPlugin } from "./builtin/tool/read.ts";
import { writePlugin } from "./builtin/tool/write.ts";

/**
 * Every plugin the harness ships, and the selection a caller who passes no `plugins` gets. Tool
 * contributors come first; within the prompt domain, declaration order is run order.
 */
export const builtins = Object.freeze([
	bashPlugin,
	readPlugin,
	writePlugin,
	editPlugin,
	defaultPromptPlugin,
	instructionPlugin,
]);
