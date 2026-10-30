import { Effect, Schema } from "effect";
import { ToolOffer } from "../../../tool/offer.ts";
import { ToolSearch } from "../../../tool/search.ts";
import * as Tool from "../../../tool/tool.ts";
import type { Builtin } from "../../plugin.ts";

/**
 * The built-in toolsearch plugin: the model searches the deferred tools it is not offered yet,
 * and the matches are loaded for its next request. Loading writes the thread's `agent`
 * `modelTools.add`, so loaded tools stay offered on that line.
 */

export const TOOL_SEARCH_NAME = "toolsearch";
export const DEFAULT_LIMIT = 8;

// Fixed, so it does not change as deferred tools are registered, for example as MCP servers connect.
const DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_NAME}\`.`;

const ToolSearchParams = Schema.Struct({
	query: Schema.String.annotate({ description: "Search query for deferred tools." }),
	limit: Schema.optional(
		Schema.Finite.annotate({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_LIMIT}.` }),
	),
});

/** The `details` of a completed call: the tools it loaded, best match first. */
export const ToolSearchDetails = Schema.Struct({ loaded: Schema.Array(Schema.String) });
export type ToolSearchDetails = typeof ToolSearchDetails.Type;

const ToolSearchSuccess = Schema.Struct({ text: Schema.String, loaded: Schema.Array(Schema.String) });

export class ToolSearchFailed extends Schema.TaggedError<ToolSearchFailed>()("ToolSearchFailed", {
	message: Schema.String,
}) {}

export const toolSearchDef = Tool.define({
	name: TOOL_SEARCH_NAME,
	label: "toolsearch",
	description: DESCRIPTION,
	// Searching changes what the model is offered, so only the model calls it.
	exposure: "model",
	parameters: ToolSearchParams,
	success: ToolSearchSuccess,
	failure: ToolSearchFailed,
	encodeContent: (success) => [{ type: "text", text: success.text }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: (success): ToolSearchDetails => ({ loaded: success.loaded }),
});

const fail = (message: string) => Effect.fail(new ToolSearchFailed({ message }));

export const toolSearchHandler: Tool.Handler<
	typeof ToolSearchParams,
	typeof ToolSearchSuccess,
	typeof ToolSearchFailed
> = Effect.fn("ToolSearch.handler")(function* ({ query, limit }) {
	if (query.trim() === "") return yield* fail("query must not be empty");
	const max = limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(max) || max <= 0) return yield* fail("limit must be a positive integer");
	const deferred = yield* (yield* ToolOffer).deferred;
	const loaded = ToolSearch.rank(
		query,
		deferred.map((tool) => ({ name: tool.name, text: ToolSearch.text(tool) })),
		max,
	);
	const listed = loaded.map((name) => {
		const description = deferred.find((tool) => tool.name === name)?.description ?? "";
		return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`;
	});
	const text =
		loaded.length === 0
			? "No matching tools found."
			: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${listed.join("\n")}`;
	return { text, loaded };
});

export const toolSearchTool = Tool.implement(toolSearchDef, toolSearchHandler);

export const toolSearchPlugin: Builtin = {
	id: "codework.tool.toolsearch",
	kind: "tool",
	optIn: true,
	whenDeferred: true,
	setup: (ctx) => {
		// Held to the end of its domain, it must not override a `toolsearch` another plugin registered.
		if (!ctx.plugin.tools.has(TOOL_SEARCH_NAME)) ctx.plugin.tools.add(Tool.register(toolSearchTool));
	},
};
