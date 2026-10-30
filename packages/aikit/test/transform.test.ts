import type { ModelMessage } from "ai";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import {
	convertMessages,
	convertTools,
	encodeOpenAIReasoningSignature,
	googleThoughtSignature,
	mapUsage,
	normalizeOpenAICodexToolCallId,
} from "../src/llm/transform.ts";
import * as Message from "../src/message/message.ts";
import * as Model from "../src/model/model.ts";
import { openAICodexTools } from "../src/providers/openai-codex/index.ts";
import { shortHash } from "../src/utils/hash.ts";
import { stream } from "../src/llm/stream.ts";
import { fakeAnthropic, textReply } from "./utils/anthropic.ts";
import {
	makeAssistantMessage,
	makeLanguageModelUsage,
	makeCompletedToolCall,
	makeModel,
	makePendingToolCall,
	makeUserMessage,
} from "./utils/fixtures.ts";

const PNG = "aGVsbG8=";

describe("Google thought signature replay", () => {
	it.each(["google", "google-vertex"] as const)("retains signatures in the %s namespace", (protocol) => {
		const model = makeModel({ protocol });
		const message = makeAssistantMessage(model, {
			parts: [
				{ type: "text", text: "Answer", textSignature: "text-signature" },
				{ type: "thinking", thinking: "Reasoning", thinkingSignature: "thinking-signature" },
				{ ...makeCompletedToolCall("call"), thoughtSignature: "tool-signature" },
			],
		});
		const converted = convertMessages({ messages: [message] }, model);
		expect(converted[0]).toMatchObject({
			content: [
				{ type: "text", providerOptions: { [protocol]: { thoughtSignature: "text-signature" } } },
				{ type: "reasoning", providerOptions: { [protocol]: { thoughtSignature: "thinking-signature" } } },
				{ type: "tool-call", providerOptions: { [protocol]: { thoughtSignature: "tool-signature" } } },
			],
		});
		expect(googleThoughtSignature({ [protocol]: { thoughtSignature: "tool-signature" } })).toBe("tool-signature");
		const switched = convertMessages({ messages: [message] }, { ...model, id: "another-model" });
		expect(JSON.stringify(switched)).not.toContain("-signature");
	});
});
const unpairedSurrogate = String.fromCharCode(0xd83d);

const sameModel = makeModel();
const otherModel = makeModel({
	id: "other-model",
	provider: { id: "other-provider", name: "Other", source: "custom", env: [] },
	protocol: "openai",
});
const imageModel = makeModel({ input: ["text", "image"] });

function makeOpenAIModel(overrides: Partial<Model.Info> = {}): Model.Info {
	return makeModel({
		protocol: Model.KnownProviderEnum.openai,
		provider: { id: "openai", name: "OpenAI", source: "api", env: [] },
		...overrides,
	});
}

function makeCodexModel(overrides: Partial<Model.Info> = {}): Model.Info {
	return makeModel({
		protocol: Model.KnownProviderEnum.openaiCodex,
		provider: { id: "openai-codex", name: "Codex", source: "custom", env: [] },
		...overrides,
	});
}

function makeRunningToolCall(callID: string): Message.ToolCallRunningPart {
	return {
		type: "toolCall",
		callID,
		name: "test_tool",
		arguments: {},
		status: "running",
		partial: { content: [{ type: "text", text: "halfway" }] },
		time: { start: Date.now(), end: Date.now() },
	};
}

function makeErrorToolCall(
	callID: string,
	content: Array<Message.TextContent | Message.ImageContent>,
	name = "search",
): Message.ToolCallErrorPart {
	return {
		type: "toolCall",
		callID,
		name,
		arguments: {},
		status: "error",
		result: { content, isError: true },
		time: { start: Date.now(), end: Date.now() },
	};
}

function expectSingleAssistant(messages: Message.Message[]): Message.AssistantMessage {
	expect(messages).toHaveLength(1);
	const message = messages[0];
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("expected assistant message");
	return message;
}

function expectToolCall(message: Message.AssistantMessage, index = 0): Message.ToolCall {
	const part = message.parts[index];
	expect(part?.type).toBe("toolCall");
	if (part?.type !== "toolCall") throw new Error("expected toolCall part");
	return part;
}

function pngUserMessage(
	parts: Message.UserMessage["parts"] = [{ type: "image", data: PNG, mimeType: "image/png" }],
): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts,
		time: { created: Date.now() },
	});
}

describe("Message.transformMessages", () => {
	it("does not mutate assistant messages", () => {
		const assistant = makeAssistantMessage(sameModel, {
			stopReason: "toolUse",
			parts: [makePendingToolCall("call-1")],
		});
		const snapshot = structuredClone(assistant);

		Message.transformMessages([assistant], otherModel);
		expect(assistant).toEqual(snapshot);
	});

	describe("thinking parts", () => {
		it("keeps signature-only (redacted) thinking parts for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "", thinkingSignature: "sig-1", redacted: true }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-1", redacted: true },
			]);
		});

		it("keeps redacted thinking parts without a signature for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "", redacted: true }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "thinking", thinking: "", redacted: true },
			]);
		});

		it("drops signed, unsigned and redacted thinking when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [
					{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig-1" },
					{ type: "thinking", thinking: "unsigned reasoning" },
					{ type: "thinking", thinking: "", thinkingSignature: "sig-2", redacted: true },
				],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual(
				assistant.parts,
			);
			expect(expectSingleAssistant(Message.transformMessages([assistant], otherModel)).parts).toEqual([]);
		});

		it("does not send another model's readable thinking as text", () => {
			const toolCall = makeCompletedToolCall("call-1");
			const assistant = makeAssistantMessage(otherModel, {
				stopReason: "toolUse",
				parts: [
					{ type: "thinking", thinking: "Candidates: proxy, IPv6, TLS.", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "Let me check the TLS versions." },
					toolCall,
				],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "text", text: "Let me check the TLS versions." },
				toolCall,
			]);
		});

		it("keeps thinking only from the target model when models alternate", () => {
			const modelB = makeModel({ id: "model-b" });
			const turn = (model: Model.Info, text: string) =>
				makeAssistantMessage(model, {
					parts: [
						{ type: "thinking", thinking: `${text} thinking`, thinkingSignature: "reasoning_content" },
						{ type: "text", text },
					],
				});
			const messages = [
				makeUserMessage("1"),
				turn(sameModel, "a1"),
				makeUserMessage("2"),
				turn(modelB, "b"),
				makeUserMessage("3"),
				turn(sameModel, "a2"),
			];

			const parts = Message.transformMessages(messages, sameModel)
				.filter((message) => message.role === "assistant")
				.map((message) => (message as Message.AssistantMessage).parts);
			expect(parts).toEqual([
				[
					{ type: "thinking", thinking: "a1 thinking", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "a1" },
				],
				[{ type: "text", text: "b" }],
				[
					{ type: "thinking", thinking: "a2 thinking", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "a2" },
				],
			]);
		});
	});

	describe("text parts", () => {
		it("strips textSignature when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "text", text: "hello", textSignature: "msg_1" }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "text", text: "hello", textSignature: "msg_1" },
			]);
			expect(expectSingleAssistant(Message.transformMessages([assistant], otherModel)).parts).toEqual([
				{ type: "text", text: "hello" },
			]);
		});
	});

	describe("tool call parts", () => {
		it("strips thoughtSignature when handing off to another model", () => {
			const toolCall: Message.ToolCallCompletedPart = {
				...makeCompletedToolCall("call-1"),
				thoughtSignature: "google-sig",
			};
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [toolCall] });

			expect(
				expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], otherModel))).thoughtSignature,
			).toBeUndefined();
		});

		it("converts running tool calls into synthetic skipped results without partials", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeRunningToolCall("call-1")],
			});

			const part = expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], sameModel)));
			expect(part.status).toBe("skipped");
			expect("partial" in part).toBe(false);
		});
	});

	describe("tool call ID normalization", () => {
		/**
		 * In most cases you just want to sanitize existing call IDs; rather than generating a completely new ID.
		 * Call IDs must be unique; should never have the same call ID. e.g passing a common function that generates
		 * a single ID will duplicate call IDs across multiple call IDs.
		 */
		it("rewrites tool call IDs via the callback when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call_legacy/1")],
			});

			expect(
				expectToolCall(
					expectSingleAssistant(
						Message.transformMessages([assistant], otherModel, (id) => id.replaceAll("/", "_")),
					),
				).callID,
			).toBe("call_legacy_1");
		});

		it("applies the same mapping to later occurrences of the same ID", () => {
			const first = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call/1")],
			});
			const second = makeAssistantMessage(sameModel, {
				parts: [makeCompletedToolCall("call/1")],
			});

			let calls = 0;
			const result = Message.transformMessages([first, second], otherModel, (id) => {
				calls += 1;
				return id.replaceAll("/", "-");
			});
			const firstMessage = result[0];
			const secondMessage = result[1];
			expect(firstMessage?.role).toBe("assistant");
			expect(secondMessage?.role).toBe("assistant");
			if (firstMessage?.role !== "assistant" || secondMessage?.role !== "assistant") {
				throw new Error("expected assistant messages");
			}

			expect(expectToolCall(firstMessage).callID).toBe("call-1");
			expect(expectToolCall(secondMessage).callID).toBe("call-1");
			expect(calls).toBe(1);
		});
	});
});

describe("mapUsage", () => {
	const model = makeModel({
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	});

	it("subtracts cached read and write tokens from inputTokens when no noCacheTokens breakdown is available", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 20 },
			}),
			model,
		);
		expect(usage.input).toBe(50);
		expect(usage.cacheRead).toBe(30);
		expect(usage.cacheWrite).toBe(20);
		expect(usage.output).toBe(50);
		expect(usage.totalTokens).toBe(150);
	});

	/**
	 * We get full breakdown when noCacheTokens is present within inputTokenDetails
	 * No subtraction is required
	 **/
	it("use noCacheTokens within inputTokenDetails when present", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 100,
				outputTokens: 10,
				totalTokens: 110,
				inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 35, cacheWriteTokens: 25 },
			}),
			model,
		);
		expect(usage.input).toBe(40);
		expect(usage.cacheRead).toBe(35);
		expect(usage.cacheWrite).toBe(25);
		expect(usage.output).toBe(10);
		expect(usage.totalTokens).toBe(110);
	});

	it("never reports negative input tokens", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 10,
				outputTokens: 0,
				totalTokens: 10,
				inputTokenDetails: { cacheReadTokens: 50 },
			}),
			model,
		);
		expect(usage.input).toBe(0);
	});

	it("preserves reasoning usage and applies a request cost multiplier", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				totalTokens: 2_000_000,
				inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
				outputTokenDetails: { textTokens: 750_000, reasoningTokens: 250_000 },
			}),
			model,
			0.5,
		);

		expect(usage.reasoning).toBe(250_000);
		expect(usage.cost.input).toBeCloseTo(1.5);
		expect(usage.cost.output).toBeCloseTo(7.5);
	});
});

describe("convertTools", () => {
	it("returns undefined for missing or empty tools", () => {
		expect(convertTools(undefined)).toBeUndefined();
		expect(convertTools([])).toBeUndefined();
	});

	it("falls back to a regular tool when codex grammar tools are unsupported", () => {
		const tool = openAICodexTools.custom({
			name: "sample",
			description: "Generate a sample",
			parameters: Type.Object({ payload: Type.String() }),
			format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
		});
		expect(
			convertTools([tool], makeCodexModel({ compat: { supportsOpenAIGrammarTools: false } }))?.sample
				?.providerOptions,
		).toBeUndefined();
	});

	it("rejects grammar tools whose schema is not exactly one required string property", () => {
		const tool = openAICodexTools.custom({
			name: "sample",
			description: "Generate a sample",
			parameters: Type.Object({ payload: Type.String(), extra: Type.String() }),
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});
		expect(() => convertTools([tool], makeCodexModel({ compat: { supportsOpenAIGrammarTools: true } }))).toThrow(
			"exactly one required string property",
		);
	});

	it("enables strict JSON schema tools when supported and rejects required strict mode otherwise", () => {
		const tool = Message.defineTool({
			name: "strict_tool",
			description: "Strict tool",
			parameters: Type.Object({ value: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "require" },
		});
		const supported = makeModel({ compat: { supportsStrictMode: true } });
		const unsupported = makeModel({ compat: { supportsStrictMode: false } });

		expect(convertTools([tool], supported)?.strict_tool?.strict).toBe(true);
		expect(convertTools([tool], makeModel())?.strict_tool?.strict).toBe(true);
		expect(() => convertTools([tool], unsupported)).toThrow("requires JSON-schema constrained sampling");
	});

	it("omits strict mode when prefer is set and the model does not support it", () => {
		const tool = Message.defineTool({
			name: "strict_tool",
			description: "Strict tool",
			parameters: Type.Object({ value: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		});
		const unsupported = makeModel({ compat: { supportsStrictMode: false } });

		expect(convertTools([tool], unsupported)?.strict_tool?.strict).toBeUndefined();
	});
});

/**
 * Note: keep in sync with openAI provider
 */
describe("encodeOpenAIReasoningSignature", () => {
	it("preserves a null encrypted reasoning payload", () => {
		expect(encodeOpenAIReasoningSignature({ openai: { itemId: "rs_1", reasoningEncryptedContent: null } })).toBe(
			JSON.stringify({ itemId: "rs_1", reasoningEncryptedContent: null }),
		);
	});
});

describe("GitHub Copilot thinking replay", () => {
	const copilotModel = (method: Model.APIMethodEnum) =>
		makeModel({
			id: "copilot-model",
			provider: { id: "github-copilot", name: "GitHub Copilot", source: "custom", env: [] },
			protocol: Model.KnownProviderEnum.githubCopilot,
			api: { id: "copilot-model", method },
		});
	const openaiSignature = JSON.stringify({ itemId: "rs_9", reasoningEncryptedContent: "enc-9" });

	it("replays Responses reasoning items under the github-copilot key, including older signatures", () => {
		const model = copilotModel(Model.APIMethodEnum.responses);
		const item = JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] });
		const message = makeAssistantMessage(model, {
			parts: [
				{ type: "thinking", thinking: "current", thinkingSignature: item },
				{ type: "thinking", thinking: "older", thinkingSignature: openaiSignature },
				{ type: "thinking", thinking: "unsigned" },
			],
		});
		const converted = convertMessages({ messages: [message] }, model);
		expect(converted[0]?.content).toEqual([
			{ type: "reasoning", text: "current", providerOptions: { "github-copilot": { reasoningItem: item } } },
			{
				type: "reasoning",
				text: "older",
				providerOptions: {
					"github-copilot": {
						reasoningItem: JSON.stringify({
							type: "reasoning",
							id: "rs_9",
							encrypted_content: "enc-9",
							summary: [],
						}),
					},
				},
			},
		]);
	});

	it("replays Anthropic signatures on the Messages route", () => {
		const model = copilotModel(Model.APIMethodEnum.messages);
		const message = makeAssistantMessage(model, {
			parts: [{ type: "thinking", thinking: "reasoned", thinkingSignature: "sig_anthropic" }],
		});
		const converted = convertMessages({ messages: [message] }, model);
		expect(converted[0]?.content).toEqual([
			{
				type: "reasoning",
				text: "reasoned",
				providerOptions: { anthropic: { signature: "sig_anthropic" } },
			},
		]);
	});

	it("does not hand a foreign signature to the wrong Copilot endpoint", () => {
		const model = copilotModel(Model.APIMethodEnum.messages);
		const message = makeAssistantMessage(model, {
			parts: [{ type: "thinking", thinking: "reasoned", thinkingSignature: openaiSignature }],
		});
		const converted = convertMessages({ messages: [message] }, model);
		expect(converted[0]?.content).toEqual([{ type: "text", text: "reasoned" }]);
	});
});

/**
 * Note: keep this in sync with custom codex provider; take cues from codex source code
 */
describe("normalizeOpenAICodexToolCallId", () => {
	const target = makeCodexModel({ id: "gpt-5.6-luna" });

	it("sanitizes ids that do not include an item separator", () => {
		expect(normalizeOpenAICodexToolCallId("call with spaces", target, makeAssistantMessage(target))).toBe(
			"call_with_spaces",
		);
	});

	it("hashes the item id when the source provider is foreign", () => {
		const foreign = makeAssistantMessage(
			makeModel({ id: "foreign", protocol: Model.KnownProviderEnum.openaiCompatible }),
		);
		expect(normalizeOpenAICodexToolCallId("call with spaces|foreign/item/id", target, foreign)).toBe(
			`call_with_spaces|fc_${shortHash("foreign/item/id")}`,
		);
	});

	it("prefixes same-provider item ids that are missing fc_ or ctc_", () => {
		expect(normalizeOpenAICodexToolCallId("call_1|item1", target, makeAssistantMessage(target))).toBe(
			"call_1|fc_item1",
		);
	});
});

describe("convertMessages", () => {
	it("replaces user images with a placeholder when the model does not support image input", () => {
		const userMessage = pngUserMessage([
			{ type: "text", text: "look" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		]);

		expect(convertMessages({ messages: [userMessage] }, imageModel)[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "file", data: PNG, mediaType: "image/png" },
			],
		});
		expect(convertMessages({ messages: [userMessage] }, sameModel)[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "text", text: "(image omitted: model does not support images)" },
			],
		});
	});

	it("collapses consecutive user images into one placeholder", () => {
		const images: Message.UserMessage["parts"] = [
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		];
		expect(convertMessages({ messages: [pngUserMessage(images)] }, sameModel)).toEqual([
			{ role: "user", content: [{ type: "text", text: "(image omitted: model does not support images)" }] },
		]);
	});

	it("replaces tool result images with a placeholder when the model does not support image input", () => {
		const assistant = makeAssistantMessage(sameModel, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "screenshot", [
					{ type: "text", text: "captured" },
					{ type: "image", data: PNG, mimeType: "image/png" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			],
		});
		expect(
			convertMessages({ messages: [assistant] }, sameModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [
				{ output: { type: "text", value: "captured\n(tool image omitted: model does not support images)" } },
			],
		});
	});

	it("drops whitespace text but keeps a sibling image", () => {
		expect(
			convertMessages(
				{
					messages: [
						pngUserMessage([
							{ type: "text", text: "  \n " },
							{ type: "image", data: PNG, mimeType: "image/png" },
						]),
					],
				},
				imageModel,
			),
		).toMatchObject([{ role: "user", content: [{ type: "file", data: PNG, mediaType: "image/png" }] }]);
	});

	it.each([
		{ type: "thinking" as const, thinking: "step by step" },
		{ type: "thinking" as const, thinking: "step by step", thinkingSignature: "{}" },
	])("omits OpenAI reasoning without a valid encoded signature", (part) => {
		const openAIModel = makeOpenAIModel();
		const assistant = makeAssistantMessage(openAIModel, { parts: [part] });

		expect(convertMessages({ messages: [assistant] }, openAIModel)).toEqual([]);
	});

	it("attaches Codex message ids from text signatures", () => {
		const codexModel = makeCodexModel();
		const assistant = makeAssistantMessage(codexModel, {
			parts: [{ type: "text", text: "calling", textSignature: "msg_1" }],
		});
		expect(convertMessages({ messages: [assistant] }, codexModel)).toMatchObject([
			{ content: [{ type: "text", text: "calling", providerOptions: { "openai-codex": { messageId: "msg_1" } } }] },
		]);
	});

	it("attaches Codex reasoning items from thinking signatures", () => {
		const codexModel = makeCodexModel();
		const assistant = makeAssistantMessage(codexModel, {
			parts: [
				{
					type: "thinking",
					thinking: "reasoning",
					thinkingSignature: '{"type":"reasoning","id":"rs_1","encrypted_content":"secret"}',
				},
			],
		});
		expect(convertMessages({ messages: [assistant] }, codexModel)).toMatchObject([
			{
				content: [
					{
						type: "reasoning",
						text: "reasoning",
						providerOptions: { "openai-codex": { reasoningItem: expect.stringContaining("rs_1") } },
					},
				],
			},
		]);
	});

	it("preserves empty signed Codex reasoning for encrypted replay", () => {
		const codexModel = makeCodexModel();
		const assistant = makeAssistantMessage(codexModel, {
			parts: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: '{"type":"reasoning","id":"rs_1","encrypted_content":"secret"}',
				},
			],
		});

		expect(convertMessages({ messages: [assistant] }, codexModel)).toMatchObject([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "",
						providerOptions: { "openai-codex": { reasoningItem: expect.stringContaining("rs_1") } },
					},
				],
			},
		]);
	});

	it("attaches Codex namespace metadata and declares later tools in place", () => {
		const codexModel = makeCodexModel({
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		});
		const toolCall: Message.ToolCallCompletedPart = {
			...makeCompletedToolCall("call-1|fc-1", "search", [{ type: "text", text: "found" }], { query: "x" }),
			namespace: "workspace",
		};
		const assistant = makeAssistantMessage(codexModel, { stopReason: "toolUse", parts: [toolCall] });
		const lateTool: Message.Tool = { name: "late_tool", description: "Late", parameters: { type: "object" } };
		const loaded = Message.createSystemMessage({ toolsAdded: [lateTool] });
		const messages = convertMessages({ messages: [assistant, loaded] }, codexModel);

		expect(messages[0]).toMatchObject({
			role: "assistant",
			content: [{ providerOptions: { "openai-codex": { namespace: "workspace" } } }],
		});
		expect(messages[1]).toMatchObject({ role: "tool" });
		expect(messages[2]).toMatchObject({
			role: "system",
			content: "",
			providerOptions: {
				"openai-codex": { toolChange: { mode: "changes", tools: [{ name: "late_tool" }], removed: [] } },
			},
		});

		// `activeTools` filters only the top-level list, so a limited request declares nothing in place.
		const limited = convertMessages({ messages: [assistant, loaded], tools: [lateTool] }, codexModel, undefined, [
			"late_tool",
		]);
		expect(limited.some((message) => message.role === "system")).toBe(false);
	});

	it("omits item ids when replaying a prior Codex model id", () => {
		const target = makeCodexModel({ id: "gpt-5.6-luna" });
		const assistant = makeAssistantMessage(makeCodexModel({ id: "gpt-6-luna" }), {
			stopReason: "toolUse",
			parts: [makeCompletedToolCall("call_1|fc_1", "search")],
		});
		expect(convertMessages({ messages: [assistant] }, target)).toMatchObject([
			{
				content: [
					{
						providerOptions: { "openai-codex": { omitItemId: true } },
						toolCallId: "call_1|fc_1",
					},
				],
			},
			{ content: [{ toolCallId: "call_1|fc_1" }] },
		]);
	});

	it("does not put Google thoughtSignature on the wire", () => {
		const toolCall: Message.ToolCallCompletedPart = {
			...makeCompletedToolCall("call-1", "search", [{ type: "text", text: "ok" }], { query: "x" }),
			thoughtSignature: "google-sig",
		};
		const assistant = makeAssistantMessage(imageModel, { stopReason: "toolUse", parts: [toolCall] });
		expect(JSON.stringify(convertMessages({ messages: [assistant] }, imageModel))).not.toContain("google-sig");
	});

	it("falls back to a generic message for empty error results", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makeErrorToolCall("call-1", [])],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [{ output: { type: "error-text", value: "tool returned an error" } }],
		});
	});

	it("keeps error result images in place on the OpenAI Responses wire", () => {
		const openai = makeOpenAIModel({ npm: "@ai-sdk/openai", input: ["text", "image"] });
		const assistant = makeAssistantMessage(openai, {
			stopReason: "toolUse",
			parts: [
				makeErrorToolCall("call-1", [
					{ type: "text", text: "failed" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			],
		});
		expect(convertMessages({ messages: [assistant] }, openai).slice(1)).toEqual([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "search",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "failed" },
								{ type: "file", data: { type: "data", data: PNG }, mediaType: "image/png" },
							],
						},
					},
				],
			},
		]);
	});

	it("sanitizes unpaired surrogates in tool arguments and results", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "echo", [{ type: "text", text: `out ${unpairedSurrogate} put` }], {
					note: `in ${unpairedSurrogate} put`,
					nested: { list: [`x ${unpairedSurrogate} y`] },
				}),
			],
		});

		const messages = convertMessages({ messages: [assistant] }, imageModel);
		expect(messages[0]).toMatchObject({
			content: [{ input: { note: "in  put", nested: { list: ["x  y"] } } }],
		});
		expect(messages[1]).toMatchObject({
			content: [{ output: { value: "out  put" } }],
		});
	});
});

describe("Anthropic error tool results with images", () => {
	const claude = makeModel({ npm: "@ai-sdk/anthropic", input: ["text", "image"] });
	const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

	async function wireMessages(parts: Message.AssistantMessage["parts"]) {
		const server = fakeAnthropic(textReply);
		const context: Message.Context = {
			messages: [
				makeUserMessage("Show the screenshots"),
				makeAssistantMessage(claude, { stopReason: "toolUse", parts }),
			],
		};
		await stream(claude, context, { apiKey: "test-key", factoryOptions: { fetch: server.fetch } }).result();
		return (server.body() as { messages: unknown[] }).messages;
	}

	it("moves the images after the tool results of the turn", async () => {
		const messages = await wireMessages([
			makeErrorToolCall(
				"call-1",
				[
					{ type: "text", text: "Script failed" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "image", data: "CCCC", mimeType: "image/png" },
					{ type: "text", text: "Script error" },
				],
				"codemode",
			),
			makeCompletedToolCall("call-2", "read", [{ type: "image", data: "BBBB", mimeType: "image/png" }]),
		]);

		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: "Script failed\n(image attached after the tool results)\nScript error",
					is_error: true,
				},
				{ type: "tool_result", tool_use_id: "call-2", content: [image("BBBB")] },
				{ type: "text", text: "Images from the error result of tool call call-1 (codemode):" },
				image("AAAA"),
				image("CCCC"),
			],
		});
	});

	it("sends the images of every error result after all tool results, in call order", async () => {
		const messages = await wireMessages([
			makeErrorToolCall("call-1", [{ type: "image", data: "AAAA", mimeType: "image/png" }], "screenshot"),
			makeCompletedToolCall("call-2", "search", [{ type: "text", text: "found" }]),
			makeErrorToolCall(
				"call-3",
				[
					{ type: "text", text: "Render failed" },
					{ type: "image", data: "BBBB", mimeType: "image/png" },
				],
				"render",
			),
		]);

		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: "(image attached after the tool results)",
					is_error: true,
				},
				{ type: "tool_result", tool_use_id: "call-2", content: "found" },
				{
					type: "tool_result",
					tool_use_id: "call-3",
					content: "Render failed\n(image attached after the tool results)",
					is_error: true,
				},
				{ type: "text", text: "Images from the error result of tool call call-1 (screenshot):" },
				image("AAAA"),
				{ type: "text", text: "Images from the error result of tool call call-3 (render):" },
				image("BBBB"),
			],
		});
	});

	it("keeps error tool results without images unchanged", async () => {
		const messages = await wireMessages([
			makeErrorToolCall("call-1", [{ type: "text", text: "Script failed" }], "codemode"),
		]);

		expect(messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call-1", content: "Script failed", is_error: true }],
		});
	});

	it("omits error result images for a text-only model without splitting", async () => {
		const assistant = makeAssistantMessage(sameModel, {
			stopReason: "toolUse",
			parts: [
				makeErrorToolCall("call-1", [
					{ type: "text", text: "failed" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			],
		});
		expect(convertMessages({ messages: [assistant] }, sameModel).slice(1)).toMatchObject([
			{
				role: "tool",
				content: [
					{
						output: {
							type: "error-text",
							value: "failed\n(tool image omitted: model does not support images)",
						},
					},
				],
			},
		]);
	});
});

describe("tool result images on wires that cannot carry them", () => {
	const turn = (model: Model.Info) =>
		makeAssistantMessage(model, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "screenshot", [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
				makeErrorToolCall(
					"call-2",
					[
						{ type: "text", text: "Render failed" },
						{ type: "image", data: "BBBB", mimeType: "image/png" },
					],
					"render",
				),
			],
		});
	const file = (data: string) => ({ type: "file", data, mediaType: "image/png" });
	const outputs = (messages: ModelMessage[]) =>
		messages.flatMap((message) =>
			message.role === "tool" ? message.content.map((part) => ("output" in part ? part.output : part)) : [],
		);

	it("sends Chat Completions tool results as text and their images in one user message", () => {
		const chat = makeModel({
			npm: "@ai-sdk/openai-compatible",
			protocol: "openai-compatible",
			input: ["text", "image"],
		});
		const messages = convertMessages({ messages: [turn(chat)] }, chat);

		expect(outputs(messages)).toEqual([
			{ type: "text", value: "(see attached image)" },
			{ type: "error-text", value: "Render failed" },
		]);
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, file("AAAA"), file("BBBB")],
		});
	});

	it("uses Chat Completions for OpenAI only when the request picks the chat method", () => {
		const openai = makeOpenAIModel({ npm: "@ai-sdk/openai", input: ["text", "image"] });

		expect(convertMessages({ messages: [turn(openai)] }, openai).at(-1)?.role).toBe("tool");
		expect(convertMessages({ messages: [turn(openai)] }, openai, Model.APIMethodEnum.chat).at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, file("AAAA"), file("BBBB")],
		});
	});

	it("sends each tool result's images after the results for Gemini before 3", () => {
		const gemini = makeModel({
			id: "gemini-2.5-flash",
			npm: "@ai-sdk/google",
			protocol: "google",
			input: ["text", "image"],
		});
		const messages = convertMessages({ messages: [turn(gemini)] }, gemini);

		expect(outputs(messages)).toEqual([
			{ type: "text", value: "(see attached image)" },
			{ type: "error-text", value: "Render failed" },
		]);
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Tool result image:" },
				file("AAAA"),
				{ type: "text", text: "Tool result image:" },
				file("BBBB"),
			],
		});
	});

	it("keeps images inside the function response from Gemini 3", () => {
		const gemini = makeModel({
			id: "gemini-3.5-flash",
			npm: "@ai-sdk/google",
			protocol: "google",
			input: ["text", "image"],
		});
		const messages = convertMessages({ messages: [turn(gemini)] }, gemini);

		expect(messages.at(-1)?.role).toBe("tool");
		expect(outputs(messages).map((output) => (output as { type: string }).type)).toEqual(["content", "content"]);
	});

	it("follows the Copilot endpoint the request resolves to", () => {
		const copilot = (method: Model.APIMethodEnum) =>
			makeModel({
				npm: "@codeworksh/ai-sdk-github-copilot",
				protocol: "github-copilot",
				input: ["text", "image"],
				api: { method },
			});
		const messagesEntry = copilot(Model.APIMethodEnum.messages);
		const chatEntry = copilot(Model.APIMethodEnum.chat);
		const last = (model: Model.Info, method?: Model.APIMethodEnum) =>
			convertMessages({ messages: [turn(model)] }, model, method).at(-1);

		expect(last(messagesEntry)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Images from the error result of tool call call-2 (render):" }, file("BBBB")],
		});
		expect(last(messagesEntry, Model.APIMethodEnum.chat)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, file("AAAA"), file("BBBB")],
		});
		expect(last(chatEntry, Model.APIMethodEnum.messages)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Images from the error result of tool call call-2 (render):" }, file("BBBB")],
		});
		expect(last(chatEntry, Model.APIMethodEnum.responses)?.role).toBe("tool");
	});

	it("matches the Google adapter's legacy models, on Gemini and Vertex", () => {
		const legacy = [
			"gemini-2.5-flash",
			"gemini-1.5-pro",
			"gemini-pro-vision",
			"gemini-robotics-er-1.5",
			"gemma-3-27b-it",
		];
		for (const id of legacy) {
			for (const [protocol, npm] of [
				["google", "@ai-sdk/google"],
				["google-vertex", "@ai-sdk/google-vertex"],
			] as const) {
				const model = makeModel({ id, protocol, npm, input: ["text", "image"] });
				expect(convertMessages({ messages: [turn(model)] }, model).at(-1)?.role, `${protocol}/${id}`).toBe("user");
			}
		}
		const current = makeModel({
			id: "gemini-3.5-flash",
			protocol: "google-vertex",
			npm: "@ai-sdk/google-vertex",
			input: ["text", "image"],
		});
		expect(convertMessages({ messages: [turn(current)] }, current).at(-1)?.role).toBe("tool");
	});

	it("keeps every round's images after its own tool results", () => {
		const chat = makeModel({
			npm: "@ai-sdk/openai-compatible",
			protocol: "openai-compatible",
			input: ["text", "image"],
		});
		const round = (callID: string, data: string) =>
			makeAssistantMessage(chat, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall(callID, "screenshot", [{ type: "image", data, mimeType: "image/png" }])],
			});
		const messages = convertMessages(
			{
				messages: [
					makeUserMessage("go"),
					round("call-1", "AAAA"),
					round("call-2", "BBBB"),
					makeUserMessage("next"),
				],
			},
			chat,
		);

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
			"tool",
			"user",
			"user",
		]);
		expect(messages[3]).toEqual({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, file("AAAA")],
		});
		expect(messages[6]).toEqual({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, file("BBBB")],
		});
	});

	it("moves nothing for a text-only model, whose images are already placeholders", () => {
		const chat = makeModel({ npm: "@ai-sdk/openai-compatible", protocol: "openai-compatible", input: ["text"] });
		const messages = convertMessages({ messages: [turn(chat)] }, chat);

		expect(messages.at(-1)?.role).toBe("tool");
		expect(outputs(messages)).toEqual([
			{ type: "text", value: "(tool image omitted: model does not support images)" },
			{ type: "error-text", value: "Render failed\n(tool image omitted: model does not support images)" },
		]);
	});
});
