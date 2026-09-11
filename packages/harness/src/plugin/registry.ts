import { make as makeTools } from "./tool/registry.ts";
import { make as makePrompt } from "./prompt/registry.ts";
import { make as makeCatalog } from "../tools/registry.ts";
import type { ToolRegistry } from "./tool/schema.ts";
import type { PromptRegistry } from "./prompt/schema.ts";

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
			const systemPrompt = prompt.value();
			if (systemPrompt === undefined) throw new Error("No Prompt plugin set a system prompt");
			return { tools: makeCatalog(tools.entries()).resolve(), systemPrompt };
		},
	};
};
