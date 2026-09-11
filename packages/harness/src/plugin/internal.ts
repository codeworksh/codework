import { bashPlugin } from "./internal/tool/bash.ts";
import { defaultPromptPlugin } from "./internal/prompt/default.ts";
import { guidelinesPromptPlugin } from "./internal/prompt/guidelines.ts";

export const builtins = Object.freeze([bashPlugin, defaultPromptPlugin, guidelinesPromptPlugin]);
export const defaults = builtins;
export const defaultRefs = Object.freeze(builtins.map((plugin) => plugin.id));
