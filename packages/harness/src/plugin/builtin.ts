import { defaultPromptPlugin } from "./builtin/prompt/default.ts";
import { bashPlugin } from "./builtin/tool/bash.ts";

/**
 * Every plugin the harness ships, and the selection a caller who passes no `plugins` gets. Tool
 * contributors come first so the Prompt plugin that indexes them runs after they registered.
 */
export const builtins = Object.freeze([bashPlugin, defaultPromptPlugin]);
