/**
 * MCP tools as harness tools: their names, which of them the model sees, and how a call's result
 * reaches it.
 */

import type { Exposure, ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { ToolProgress } from "../tool/progress.ts";
import * as Tool from "../tool/tool.ts";
import { Hash } from "../util/hash.ts";
import { McpContent } from "./content.ts";
import type { Progress } from "./client.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, with everything but `[A-Za-z0-9_]` replaced by `_`. A name that is too
 * long, or that `taken` reports as used by another MCP tool, ends in a hash of the server and tool
 * instead: sanitizing can map two tools to one name (`a-b` and `a_b`).
 */
export const name = (server: string, tool: string, taken: (candidate: string) => boolean = () => false) => {
	const plain = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (plain.length <= MAX_NAME_LENGTH && !taken(plain)) return plain;
	const suffix = Hash.sha256(`${server}\0${tool}`).slice(0, 8);
	return `${plain.slice(0, MAX_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
};

/**
 * The tool names of one session. A name, once given to a server's tool, stays with it for the
 * session, so a reconnect or a changed tool list never moves a name to a different tool.
 */
export const names = () => {
	const owners = new Map<string, string>();
	/** Names for `tools`, every tool of `server` the server offers right now. */
	return (server: string, tools: ReadonlyArray<string>): ReadonlyMap<string, string> => {
		const assigned = new Map<string, string>();
		const used = new Set<string>();
		// Every tool whose sanitized name collides gets the suffix, so which one would keep the plain
		// name does not depend on the order of the list.
		const plain = [...new Set(tools)].map((tool) => name(server, tool));
		for (const tool of new Set(tools)) {
			const owner = `${server}\0${tool}`;
			const given = name(server, tool, (candidate) => {
				const existing = owners.get(candidate);
				return (
					(existing !== undefined && existing !== owner) ||
					used.has(candidate) ||
					plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
				);
			});
			owners.set(given, owner);
			used.add(given);
			assigned.set(tool, given);
		}
		return assigned;
	};
};

const pattern = (glob: string) =>
	new RegExp(
		`^${glob
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);

/** One tool's exposure: its `toolExposure` entry (exact name first, then patterns), else the server's. */
export const exposure = (config: ServerConfig, tool: string): Exposure => {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[tool];
	if (exact !== undefined) return exact;
	for (const [glob, value] of Object.entries(overrides)) {
		if (glob.includes("*") && pattern(glob).test(tool)) return value;
	}
	return config.exposure ?? "direct";
};

/** What the model reads, kept the same for a result and for a failure. */
const Outcome = Schema.Struct({
	content: Schema.Array(Schema.Unknown),
	server: Schema.String,
	tool: Schema.String,
	structuredContent: Schema.optional(Schema.Unknown),
});
type Outcome = typeof Outcome.Type;

/** Tool input schemas must be objects; servers may omit `type`, and some providers want `properties`. */
const parameters = (schema: McpTool["inputSchema"]): Record<string, unknown> => ({
	...schema,
	type: schema.type ?? "object",
	...(schema.properties === undefined ? { properties: {} } : {}),
});

export interface Call {
	readonly args: Record<string, unknown>;
	readonly onProgress: (progress: Progress) => void;
}

/**
 * A server tool as a harness tool. `call` resolves the server's current connection when it runs, so
 * the definition can outlive the connection it was listed on. A failed call and a result the server
 * flags `isError` both reach the model as an error result.
 */
export const make = (input: {
	readonly server: string;
	readonly tool: McpTool;
	readonly name: string;
	readonly call: (call: Call) => Effect.Effect<CallToolResult, string>;
}) => {
	const { server, tool } = input;
	const title = tool.title ?? tool.annotations?.title;
	const failed = (message: string): Outcome => ({
		content: [{ type: "text", text: message }],
		server,
		tool: tool.name,
	});
	return Tool.register(
		Tool.make({
			name: input.name,
			label: `${server}/${tool.name}`,
			description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
			parameters: Tool.fromJsonSchema(parameters(tool.inputSchema)),
			success: Outcome,
			failure: Outcome,
			encodeContent: (outcome) => outcome.content as McpContent.Content[],
			encodeFailureContent: (outcome) => outcome.content as McpContent.Content[],
			encodeDetails: ({ content: _content, ...details }) => details,
			// The arguments as the model wrote them: validation only checks them, and the server, not
			// a translation of its schema, decides what they mean.
			handler: (_params, ctx) =>
				Effect.gen(function* () {
					const progress = yield* ToolProgress;
					const report = Effect.runForkWith(yield* Effect.context<never>());
					const result = yield* input
						.call({
							args: ctx.rawArgs,
							onProgress: (update) => {
								const total = update.total === undefined ? "" : `/${update.total}`;
								const text = update.message ?? `Progress ${update.progress}${total}`;
								report(progress.report({ content: [{ type: "text", text }] }));
							},
						})
						.pipe(Effect.mapError(failed));
					const content = McpContent.fromResult(result);
					if (result.isError && !content.some((block) => block.type === "text" && block.text !== ""))
						content.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error` });
					const outcome: Outcome = {
						content,
						server,
						tool: tool.name,
						...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					};
					return result.isError ? yield* Effect.fail(outcome) : outcome;
				}),
		}),
	);
};

export * as McpTool from "./tool.ts";
