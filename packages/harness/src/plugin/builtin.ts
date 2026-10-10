import { defaultPromptPlugin } from "./builtin/prompt/default.ts";
import { instructionPlugin } from "./builtin/prompt/instruction.ts";
import { bashPlugin } from "./builtin/tool/bash.ts";
import { editPlugin } from "./builtin/tool/edit.ts";
import { findPlugin } from "./builtin/tool/find.ts";
import { grepPlugin } from "./builtin/tool/grep.ts";
import { lsPlugin } from "./builtin/tool/ls.ts";
import { readPlugin } from "./builtin/tool/read.ts";
import { writePlugin } from "./builtin/tool/write.ts";

/**
 * Every plugin the harness ships, and the selection a caller who passes no `plugins` gets. Tool
 * contributors come first; within the prompt domain, declaration order is run order. The search
 * tools (grep, find, ls) are `optIn`, as Pi ships them off: settings turn each on with
 * `{ "plugin": "codework.tool.grep", "enabled": true }`.
 */
export const builtins = Object.freeze([
	bashPlugin,
	readPlugin,
	writePlugin,
	editPlugin,
	grepPlugin,
	findPlugin,
	lsPlugin,
	defaultPromptPlugin,
	instructionPlugin,
]);
