import type { PluginRegistry } from "@codeworksh/plugin/plugin";
import type { McpServer } from "@codeworksh/plugin/settings";
import { make as makeCatalog } from "../tool/registry.ts";
import { make as makeMcp } from "./mcp/registry.ts";
import { make as makePrompt } from "./prompt/registry.ts";
import { render } from "./prompt/render.ts";
import { make as makeTools } from "./tool/registry.ts";

/** The buckets a plugin writes into during `setup`. Declared in `@codeworksh/plugin`. */
export type { PluginRegistry };

/** `servers` seeds the MCP bucket: the session's `mcp.json` servers, before any plugin edits them. */
export const make = (servers: ReadonlyArray<McpServer>) => {
	const mcp = makeMcp(servers);
	const tools = makeTools();
	const prompt = makePrompt();
	const close = () => {
		mcp.settle();
		tools.close();
		prompt.close();
	};
	return {
		registry: Object.freeze<PluginRegistry>({ mcp: mcp.registry, tools: tools.registry, prompt: prompt.registry }),
		/** Close the MCP bucket and return the servers the `mcp` domain settled on. */
		settle: mcp.settle,
		close,
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
