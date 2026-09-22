import type { PromptRegistry } from "./prompt.ts";
import type { ToolRegistry } from "./tool.ts";

/**
 * What a plugin writes into during `setup`: one registry per domain.
 *
 * The buckets are open for the duration of the setup pass and frozen after it, so a plugin holds
 * the object only as long as writing to it means anything. Assembling the frozen snapshot — the
 * effective tool catalog and the final system prompt — is the harness's job, not the contract's.
 */
export interface PluginRegistry {
	readonly tools: ToolRegistry;
	readonly prompt: PromptRegistry;
}
