/**
 * MCP resources, through the tools other agents use for them: `list_mcp_resources`,
 * `list_mcp_resource_templates` and `read_mcp_resource`. They take a `server` argument and reach
 * every server with resources, so models trained on those tools use them unchanged.
 *
 * Listings are JSON: `{ server?, resources: [{ server, ...resource }], nextCursor? }`. With a
 * `server`, one page is listed and `cursor` continues it; without, every page of every server. MCP
 * App resources (`ui://` URIs and `profile=mcp-app` HTML) are left out, since they are interfaces
 * for hosts that render them, and so are icons. A read resource becomes text and images; a binary
 * one is saved to a file.
 */

import type {
	ContentBlock,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ReadResourceResult,
	Resource,
	ResourceTemplateType as ResourceTemplate,
} from "@modelcontextprotocol/client";
import { Effect, Predicate } from "effect";
import type { RegisteredTool } from "../tool/tool.ts";
import { McpContent } from "./content.ts";
import { McpTool } from "./tool.ts";

export const LIST_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_RESOURCE_TOOL = McpContent.READ_RESOURCE_TOOL;

/** A server that offers resources, reached through its current connection. */
export interface Server {
	readonly name: string;
	readonly resources: (cursor?: string) => Effect.Effect<ListResourcesResult, string>;
	readonly templates: (cursor?: string) => Effect.Effect<ListResourceTemplatesResult, string>;
	/** Every page, with the SDK's own pagination limits. */
	readonly allResources: () => Effect.Effect<ReadonlyArray<Resource>, string>;
	readonly allTemplates: () => Effect.Effect<ReadonlyArray<ResourceTemplate>, string>;
	readonly read: (uri: string) => Effect.Effect<ReadResourceResult, string>;
}

const isMcpApp = (item: {
	readonly uri?: string | undefined;
	readonly uriTemplate?: string | undefined;
	readonly mimeType?: string | undefined;
}) =>
	(item.uri ?? item.uriTemplate ?? "").startsWith("ui://") ||
	/;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");

/** A listed resource or template without `_meta` and icons, tagged with its server. */
const listed = (server: string, item: Resource | ResourceTemplate): Record<string, unknown> => {
	const { _meta: _ignored, icons: _icons, ...rest } = item;
	return { server, ...rest };
};

const property = (description: string) => ({ type: "string", description });
const LIST_PARAMETERS = {
	type: "object",
	properties: {
		server: property("MCP server name. Omit to list every server with resources."),
		cursor: property("Opaque cursor from a previous call with the same server; omit for the first page."),
	},
	additionalProperties: false,
};
const READ_PARAMETERS = {
	type: "object",
	properties: {
		server: property(
			"MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
		),
		uri: property("Resource URI to read. Must be one of the URIs returned by list_mcp_resources."),
	},
	required: ["server", "uri"],
	additionalProperties: false,
};

/** A string argument; absent when missing. */
const raw = (args: Record<string, unknown>, key: string): Effect.Effect<string | undefined, string> => {
	const value = args[key];
	if (value === undefined || value === null) return Effect.undefined;
	if (!Predicate.isString(value)) return Effect.fail(`${key} must be a string`);
	return Effect.succeed(value);
};

/** A name the model typed: trimmed, and absent when blank. */
const argument = (args: Record<string, unknown>, key: string) =>
	raw(args, key).pipe(Effect.map((value) => value?.trim() || undefined));

type Item = Resource | ResourceTemplate;
type Page = { readonly items: ReadonlyArray<Item>; readonly nextCursor?: string | undefined };

/** The three resource tools. `servers` answers, when a tool runs, which servers it reaches. */
export const make = (input: {
	readonly servers: () => ReadonlyArray<Server>;
	readonly content: Omit<McpContent.Options, "readable">;
}): ReadonlyArray<RegisteredTool> => {
	const options = { ...input.content, readable: true };
	const find = (name: string) => {
		const servers = input.servers();
		const server = servers.find((candidate) => candidate.name === name);
		if (server !== undefined) return Effect.succeed(server);
		const available = servers.map((candidate) => candidate.name).join(", ");
		return Effect.fail(
			`MCP server "${name}" has no resources${available ? `. Servers with resources: ${available}` : ""}`,
		);
	};

	const json = (payload: Record<string, unknown>) =>
		McpContent.limit([{ type: "text", text: JSON.stringify(payload) }], options).pipe(
			Effect.map((content) => ({ content, structuredContent: payload })),
		);

	/** One page of one server, or every page of every server. */
	const list = (
		key: "resources" | "resourceTemplates",
		page: (server: Server, cursor?: string) => Effect.Effect<Page, string>,
		all: (server: Server) => Effect.Effect<ReadonlyArray<Item>, string>,
	) =>
		Effect.fnUntraced(function* (args: Record<string, unknown>) {
			const name = yield* argument(args, "server");
			// A cursor is the server's opaque token, handed back exactly as it was given.
			const cursor = yield* raw(args, "cursor");
			const visible = (item: Item) => !isMcpApp(item);
			if (name !== undefined) {
				const server = yield* find(name);
				const result = yield* page(server, cursor);
				return yield* json({
					server: server.name,
					[key]: result.items.filter(visible).map((item) => listed(server.name, item)),
					...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
				});
			}
			if (cursor !== undefined) return yield* Effect.fail("cursor can only be used when a server is specified");
			const servers = [...input.servers()].sort((a, b) => a.name.localeCompare(b.name));
			const results = yield* Effect.forEach(servers, (server) => Effect.result(all(server)), {
				concurrency: "unbounded",
			});
			const items: Record<string, unknown>[] = [];
			const errors: { server: string; error: string }[] = [];
			results.forEach((result, index) => {
				const server = servers[index]!.name;
				if (result._tag === "Success")
					items.push(...result.success.filter(visible).map((item) => listed(server, item)));
				else errors.push({ server, error: result.failure });
			});
			return yield* json({ [key]: items, ...(errors.length > 0 ? { errors } : {}) });
		});

	const read = Effect.fnUntraced(function* (args: Record<string, unknown>) {
		const name = yield* argument(args, "server");
		const uri = yield* argument(args, "uri");
		if (name === undefined) return yield* Effect.fail("server must be provided");
		if (uri === undefined) return yield* Effect.fail("uri must be provided");
		const server = yield* find(name);
		const result = yield* server.read(uri);
		// Several contents (a directory, say) are labeled with their URIs.
		const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
			...(result.contents.length > 1 ? [{ type: "text" as const, text: `${contents.uri}:` }] : []),
			{ type: "resource" as const, resource: contents },
		]);
		const converted = yield* McpContent.fromBlocks(server.name, blocks, options);
		const content = yield* McpContent.limit(
			converted.length > 0 ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }],
			options,
		);
		const contents = result.contents.map(({ _meta: _ignored, ...rest }) => rest);
		return { content, structuredContent: { server: server.name, uri, contents } };
	});

	return [
		McpTool.define({
			name: LIST_RESOURCES_TOOL,
			label: LIST_RESOURCES_TOOL,
			description:
				"Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
			parameters: LIST_PARAMETERS,
			server: "",
			tool: LIST_RESOURCES_TOOL,
			run: ({ args }) =>
				list(
					"resources",
					(server, cursor) =>
						server
							.resources(cursor)
							.pipe(Effect.map((result) => ({ items: result.resources, nextCursor: result.nextCursor }))),
					(server) => server.allResources(),
				)(args),
		}),
		McpTool.define({
			name: LIST_TEMPLATES_TOOL,
			label: LIST_TEMPLATES_TOOL,
			description:
				"Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
			parameters: LIST_PARAMETERS,
			server: "",
			tool: LIST_TEMPLATES_TOOL,
			run: ({ args }) =>
				list(
					"resourceTemplates",
					(server, cursor) =>
						server
							.templates(cursor)
							.pipe(
								Effect.map((result) => ({ items: result.resourceTemplates, nextCursor: result.nextCursor })),
							),
					(server) => server.allTemplates(),
				)(args),
		}),
		McpTool.define({
			name: READ_RESOURCE_TOOL,
			label: READ_RESOURCE_TOOL,
			description: "Read a specific resource from an MCP server given the server name and resource URI.",
			parameters: READ_PARAMETERS,
			server: "",
			tool: READ_RESOURCE_TOOL,
			run: ({ args }) => read(args),
		}),
	];
};

export * as McpResources from "./resources.ts";
