import { defaultPromptPlugin } from "./internal/prompt/default.ts";
import { bashPlugin } from "./internal/tool/bash.ts";

/** Every plugin the harness ships. Seeded into the catalog whether selected or not. */
export const builtins = Object.freeze([bashPlugin, defaultPromptPlugin]);

/**
 * The selection used when a caller passes no `plugins`. Tool contributors come
 * first so the Prompt plugin that indexes them runs after they registered.
 */
export const defaultRefs = Object.freeze(builtins.map((plugin) => plugin.id));
