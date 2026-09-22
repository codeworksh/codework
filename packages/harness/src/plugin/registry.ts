import type { PluginRegistry } from "@codeworksh/plugin/plugin";
import { make as makeCatalog } from "../tool/registry.ts";
import { fallback, make as makePrompt } from "./prompt/registry.ts";
import { make as makeTools } from "./tool/registry.ts";

/** The buckets a plugin writes into during `setup`. Declared in `@codeworksh/plugin`. */
export type { PluginRegistry };

export const make = () => {
	const tools = makeTools();
	const prompt = makePrompt();
	const close = () => {
		tools.close();
		prompt.close();
	};
	return {
		registry: Object.freeze<PluginRegistry>({ tools: tools.registry, prompt: prompt.registry }),
		close,
		freeze: () => {
			close();
			return { tools: makeCatalog(tools.entries()).resolve(), systemPrompt: prompt.value() ?? fallback };
		},
	};
};
