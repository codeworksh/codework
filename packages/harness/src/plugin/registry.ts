import { make as makeCatalog } from "../tool/registry.ts";
import { fallback, make as makePrompt } from "./prompt/registry.ts";
import type { PromptRegistry } from "./prompt/schema.ts";
import { make as makeTools } from "./tool/registry.ts";
import type { ToolRegistry } from "./tool/schema.ts";

export interface PluginRegistry {
	readonly tools: ToolRegistry;
	readonly prompt: PromptRegistry;
}
export const make = () => {
	const tools = makeTools();
	const prompt = makePrompt();
	const close = () => {
		tools.close();
		prompt.close();
	};
	return {
		registry: Object.freeze({ tools: tools.registry, prompt: prompt.registry }),
		close,
		freeze: () => {
			close();
			return { tools: makeCatalog(tools.entries()).resolve(), systemPrompt: prompt.value() ?? fallback };
		},
	};
};
