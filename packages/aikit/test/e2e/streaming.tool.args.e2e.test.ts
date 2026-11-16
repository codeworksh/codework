import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Type from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { stream } from "../../src/stream.ts";
import { getAnthropicModel } from "../utils/llm.ts";

const writeTool = Message.defineTool({
	name: "write",
	description: "Write a file",
	parameters: Type.Object({
		path: Type.String(),
		content: Type.String(),
	}),
});

const LINE = 'const s = "say \\"hi\\"";\n\tif (a < b) return \'ok\'; // ünïcode 🚀 C:\\path\r\n';
const content = LINE.repeat(Math.ceil((500 * 1024) / LINE.length));
const expected = { path: "src/big.ts", content };
const argumentText = JSON.stringify(expected);

/** ~64-character pieces of the argument text, never splitting a surrogate pair. */
function splitDeltas(text: string, size: number): string[] {
	const pieces: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
		pieces.push(text.slice(start, end));
		start = end;
	}
	return pieces;
}

const deltas = splitDeltas(argumentText, 64);

function contentLength(args: Record<string, unknown>): number {
	return typeof args.content === "string" ? args.content.length : -1;
}

function sse(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function anthropicStream(): string {
	const events = [
		sse("message_start", {
			message: {
				id: "msg_local",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		}),
		sse("content_block_start", {
			index: 0,
			content_block: { type: "tool_use", id: "toolu_local", name: "write", input: {} },
		}),
		...deltas.map((partial_json) =>
			sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json } }),
		),
		sse("content_block_stop", { index: 0 }),
		sse("message_delta", {
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: deltas.length },
		}),
		sse("message_stop", {}),
	];
	return events.join("");
}

describe("streaming tool arguments", () => {
	let server: Server;
	let baseURL: string;

	beforeAll(async () => {
		const body = anthropicStream();
		server = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.end(body);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("parses ~500 KB of streamed arguments in linear time", async () => {
		const model = await getAnthropicModel("claude-sonnet-4-6");
		const context: Message.Context = {
			messages: [
				Message.createUserMessage({
					role: "user",
					parts: [{ type: "text", text: "Write src/big.ts" }],
					time: { created: Date.now() },
				}),
			],
			tools: [writeTool],
		};

		const types: { type: string; count: number }[] = [];
		// Only the latest snapshot is kept: holding every one would retain every intermediate string.
		let snapshots = 0;
		let lastPartial: Record<string, unknown> | undefined;
		let lastLength = -1;
		let mutated = false;
		let deltaCount = 0;
		let partialJsonSeen = false;

		const started = performance.now();
		const response = stream(model, context, { apiKey: "test-key", baseURL, maxRetries: 0 });
		for await (const event of response) {
			const previous = types.at(-1);
			if (previous?.type === event.type) previous.count++;
			else types.push({ type: event.type, count: 1 });

			if (event.type === "toolcall.delta") {
				deltaCount++;
				const part = event.partial.parts[event.partIndex];
				if (part?.type !== "toolCall") throw new Error("toolcall.delta without a toolCall part");
				if ("partialJson" in part) partialJsonSeen = true;
				if (part.arguments !== lastPartial) {
					// Snapshots are never mutated after they are handed out.
					if (lastPartial && contentLength(lastPartial) !== lastLength) mutated = true;
					snapshots++;
					lastPartial = part.arguments;
					lastLength = contentLength(lastPartial);
				}
			}
		}
		const message = await response.result();
		const elapsed = performance.now() - started;

		expect(message.stopReason).toBe("toolUse");
		const toolCall = message.parts.find((part) => part.type === "toolCall");
		expect(toolCall?.arguments).toEqual(expected);
		expect(toolCall && "partialJson" in toolCall).toBe(false);
		expect(partialJsonSeen).toBe(false);
		expect(deltaCount).toBe(deltas.length);
		expect(snapshots).toBeGreaterThan(1);
		expect(mutated).toBe(false);
		expect(typeof lastPartial?.content).toBe("string");
		expect(content.startsWith(lastPartial?.content as string)).toBe(true);
		expect(elapsed).toBeLessThan(2000);

		const artifact = {
			argumentBytes: Buffer.byteLength(argumentText, "utf8"),
			contentLength: content.length,
			deltas: deltas.length,
			snapshots,
			argumentsSha256: createHash("sha256").update(JSON.stringify(toolCall?.arguments)).digest("hex"),
			events: types,
		};
		await expect(JSON.stringify(artifact, null, 2) + "\n").toMatchFileSnapshot(
			"./__artifacts__/streaming-tool-args.json",
		);
	});
});
