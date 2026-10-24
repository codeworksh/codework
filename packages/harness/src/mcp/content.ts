import type { Message } from "@codeworksh/aikit";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { Image } from "../tool/image/index.ts";
import { formatSize, truncateMiddle } from "../tool/truncate.ts";
import type { OutputError } from "./error.ts";

export type Content = Message.TextContent | Message.ImageContent;

/** Model-facing text of an MCP result beyond this is cut in the middle, and saved in full. */
export const MAX_BYTES = 20 * 1024;

/** The tool that reads what a resource link names. */
export const READ_RESOURCE_TOOL = "read_mcp_resource";

/** Keeps data the model is not shown in full in a host file; `extension` includes the dot. */
export type Save = (data: string | Uint8Array, extension: string) => Effect.Effect<string, OutputError>;

export interface Options {
	readonly save: Save;
	/** Whether `read_mcp_resource` can read this server's resources, which resource links then name. */
	readonly readable: boolean;
}

/** Blobs of these types are shown as text. */
const isText = (mimeType: string | undefined) => {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
};

/** The extension a saved binary resource gets: the one its URI ends in, else `.bin`. */
const extensionOf = (uri: string) => {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
};

/**
 * An image as the model can take it inline, as the read tool does: in a supported format and within
 * the provider's limits, or a note saying why it was left out.
 */
const image = (data: string, mimeType: string) =>
	Image.inline(Buffer.from(data, "base64"), mimeType).pipe(
		Effect.map((inline): ReadonlyArray<Content> =>
			inline.ok
				? [
						{ type: "image", data: inline.data, mimeType: inline.mimeType },
						...inline.hints.map((text): Content => ({ type: "text", text })),
					]
				: [{ type: "text", text: inline.message }],
		),
	);

/** Blocks that need neither a file nor the server's name. */
const plain = (block: ContentBlock): Effect.Effect<ReadonlyArray<Content>> => {
	switch (block.type) {
		case "text":
			return Effect.succeed([{ type: "text", text: block.text }]);
		case "image":
			return image(block.data, block.mimeType);
		case "audio":
			return Effect.succeed([{ type: "text", text: `[audio ${block.mimeType} omitted]` }]);
		case "resource": {
			const resource = block.resource;
			return "text" in resource
				? Effect.succeed([{ type: "text", text: resource.text }])
				: image(resource.blob, resource.mimeType ?? "image/png");
		}
		default:
			return Effect.succeed([{ type: "text", text: `[unsupported MCP content ${block.type}]` }]);
	}
};

/** One block of `server`'s output as model content. */
const fromBlock = Effect.fnUntraced(function* (
	server: string,
	block: ContentBlock,
	options: Options,
): Effect.fn.Return<ReadonlyArray<Content>> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = options.readable ? `. Read it with ${READ_RESOURCE_TOOL} (server "${server}")` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isText(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		return yield* options.save(data, extensionOf(uri)).pipe(
			Effect.match({
				onSuccess: (path): ReadonlyArray<Content> => [
					{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` },
				],
				onFailure: (error): ReadonlyArray<Content> => [
					{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${error.message}]` },
				],
			}),
		);
	}
	return yield* plain(block);
});

/**
 * Keep model-facing text within {@link MAX_BYTES}. Longer text becomes one block with its start and
 * end, followed by the path of a file holding all of it; images follow it.
 */
export const limit = Effect.fnUntraced(function* (content: ReadonlyArray<Content>, options: Options) {
	const combined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const cut = truncateMiddle(combined, MAX_BYTES);
	if (!cut.truncated) return [...content];
	const where = yield* options.save(combined, ".txt").pipe(
		Effect.match({
			onSuccess: (path) => `[Full output: ${path} (read it with offset/limit)]`,
			onFailure: (error) => `[Could not save the full output: ${error.message}]`,
		}),
	);
	const tokens = Math.ceil(cut.totalBytes / 4);
	const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${cut.totalLines}\n\n${cut.content}\n\n${where}`;
	return [{ type: "text", text } satisfies Content, ...content.filter((block) => block.type === "image")];
});

/** Blocks of `server`'s output as model content, before {@link limit}. */
export const fromBlocks = (server: string, blocks: ReadonlyArray<ContentBlock>, options: Options) =>
	Effect.forEach(blocks, (block) => fromBlock(server, block, options)).pipe(Effect.map((all) => all.flat()));

/**
 * A tool result as model content. A result without content blocks but with `structuredContent`
 * becomes its JSON, since servers should, but do not always, mirror structured results as text.
 */
export const fromResult = Effect.fnUntraced(function* (
	server: string,
	result: Pick<CallToolResult, "content" | "structuredContent">,
	options: Options,
) {
	const content = yield* fromBlocks(server, result.content ?? [], options);
	if (content.length === 0 && result.structuredContent !== undefined) {
		// Pretty-printed JSON for the model, which Schema's encoders do not offer.
		// @effect-diagnostics-next-line preferSchemaOverJson:off
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return yield* limit(content, options);
});

export * as McpContent from "./content.ts";
