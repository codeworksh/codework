import type { PluginRegistry } from "@codeworksh/plugin/plugin";
import { make as makeCatalog } from "../tool/registry.ts";
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
		/** Close the buckets and render the snapshot; `directory` is the exchange's `<cwd>`. */
		freeze: (directory: string) => {
			close();
			const resolved = makeCatalog(tools.entries()).resolve();
			return {
				tools: resolved,
				systemPrompt: render({ prompt: prompt.snapshot(), tools: resolved.defs, directory }),
			};
		},
	};
};
