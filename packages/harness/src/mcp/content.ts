import type { Message } from "@codeworksh/aikit";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/client";

export type Content = Message.TextContent | Message.ImageContent;

const fromBlock = (block: ContentBlock): Content => {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		case "resource_link":
			return { type: "text", text: `${block.name}: ${block.uri}` };
		case "resource": {
			const resource = block.resource;
			if ("text" in resource) return { type: "text", text: resource.text };
			if (resource.mimeType?.startsWith("image/")) {
				return { type: "image", data: resource.blob, mimeType: resource.mimeType };
			}
			return {
				type: "text",
				text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
			};
		}
		default:
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
};

/**
 * A tool result as model content. A result without content blocks but with `structuredContent`
 * becomes its JSON, since servers should, but do not always, mirror structured results as text.
 */
export const fromResult = (result: Pick<CallToolResult, "content" | "structuredContent">): Content[] => {
	const content = (result.content ?? []).map(fromBlock);
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return content;
};

export * as McpContent from "./content.ts";
