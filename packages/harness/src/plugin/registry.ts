import type { PluginRegistry } from "@codeworksh/plugin/plugin";
import { make as makeCatalog, type Selection } from "../tool/registry.ts";
import { declared } from "../tool/tool.ts";
import { make as makePrompt } from "./prompt/registry.ts";
import { render } from "./prompt/render.ts";
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
		freeze: (directory: string, selection?: Selection) => {
			close();
			const resolved = makeCatalog(tools.entries()).resolve(selection);
			return {
				tools: resolved,
				// Only declared tools: loading a deferred one must not change the prompt.
				systemPrompt: render({ prompt: prompt.snapshot(), tools: resolved.defs.filter(declared), directory }),
			};
		},
	};
};
