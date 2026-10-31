import type { Message } from "@codeworksh/aikit";
import type { PluginRegistry } from "@codeworksh/plugin/plugin";
import type { Effect } from "effect";
import type { McpServer } from "@codeworksh/plugin/settings";
import { make as makeCatalog, type Selection } from "../tool/registry.ts";
import { declared } from "../tool/tool.ts";
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
		/**
		 * `live` is the MCP servers' deferred tools as they stand when searched; see `Registry.resolve`.
		 * `mcpservers` is the body of that prompt section, when there is one.
		 */
		freeze: (
			directory: string,
			selection?: Selection,
			live?: Effect.Effect<ReadonlyArray<Message.Tool>>,
			mcpservers?: string,
		) => {
			close();
			const resolved = makeCatalog(tools.entries()).resolve(selection, live);
			return {
				tools: resolved,
				// Only declared tools: loading a deferred one must not change the prompt.
				prompt: render({ prompt: prompt.snapshot(), tools: resolved.defs.filter(declared), directory, mcpservers }),
			};
		},
	};
};
