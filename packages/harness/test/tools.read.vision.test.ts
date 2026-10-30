import "./utils/env.ts";
import { createAssistantMessageEventStream, Message, type Model } from "@codeworksh/aikit";
import { Effect } from "effect";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import type { LLM } from "../src/runner/llm.ts";
import { assistant } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const image = fileURLToPath(new URL("../../aikit/test/data/red-circle.png", import.meta.url));

const model = (id: string, input: Model.Info["input"]): Model.Info => ({
	id,
	name: id,
	provider: { id: "scripted", name: "scripted", source: "custom", env: [] },
	baseUrl: "http://scripted.test/v1",
	reasoning: false,
	input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
	protocol: "openai",
});

/** A BMP header with no pixel data: detected as an image, but it cannot be converted to inline. */
const truncatedBmp = () => {
	const header = Buffer.alloc(54);
	header.write("BM", 0, "ascii");
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(2, 18);
	header.writeInt32LE(2, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	return header;
};

const textOnly = model("text-only", ["text"]);
const vision = model("vision", ["text", "image"]);

/** What the model would receive: the history after aikit's per-model transform, images reduced to their type. */
const view = (input: LLM.Input) =>
	Message.transformMessages(input.context.messages, input.resolvedModel).map((message) => {
		const content = (parts: ReadonlyArray<Message.TextContent | Message.ImageContent>) =>
			parts.map((part) => (part.type === "text" ? part.text : { image: part.mimeType }));
		if (message.role === "system") return { role: "system" };
		if (message.role === "user") return { role: "user", content: content(message.parts) };
		return {
			role: "assistant",
			parts: message.parts.map((part) =>
				part.type === "toolCall" && "result" in part
					? { toolCall: part.name, result: content(part.result.content) }
					: part.type === "text"
						? part.text
						: part.type,
			),
		};
	});

describe("read on a text-only model, then a model switch", () => {
	it("tells a text-only model each image is omitted and sends them once the model sees images", () =>
		withSettings(async ({ root, custom }) => {
			await copyFile(image, join(root, "red-circle.png"));
			await writeFile(join(root, "broken.bmp"), truncatedBmp());
			const select = (selected: Model.Info) =>
				writeFile(
					join(custom, "settings.jsonc"),
					JSON.stringify({ model: { provider: "scripted", id: selected.id }, models: [textOnly, vision] }),
				);
			const requests: Array<Record<string, unknown>> = [];
			const open: LLM.Open = (input) =>
				Effect.sync(() => {
					requests.push({ model: input.resolvedModel.id, messages: view(input) });
					const first = requests.length === 1;
					const message = assistant(
						input,
						requests.length,
						first
							? {
									stopReason: "toolUse",
									parts: ["red-circle.png", "broken.bmp"].map((path, index) => ({
										type: "toolCall" as const,
										callID: `read_${index + 1}`,
										name: "read",
										arguments: { path },
										status: "pending" as const,
										time: { start: 1, end: 1 },
									})),
								}
							: {},
					);
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
					return stream;
				});

			await Effect.runPromise(
				Effect.gen(function* () {
					yield* Effect.promise(() => select(textOnly));
					const { main: handle } = yield* Session.create({ directory: root });
					yield* handle.run("read the image");
					yield* Effect.promise(() => select(vision));
					yield* handle.run("what do you see now?");
					yield* Effect.promise(() =>
						expect(JSON.stringify(requests, null, "\t")).toMatchFileSnapshot(
							"./__artifacts__/tools.read.vision.json",
						),
					);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: root,
							database: ":memory:",
							userConfigDir: custom,
							llm: open,
						}),
					),
					Effect.scoped,
					Effect.timeout("10 seconds"),
				),
			);
		}));
});
