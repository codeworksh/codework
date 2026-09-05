import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import {
	convertMessages,
	convertTools,
	createAssistantMessage,
	encodeOpenAIReasoningSignature,
	googleThoughtSignature,
	mapFinishReason,
	mapUsage,
	normalizeOpenAICodexToolCallId,
	toolCallFromPart,
	updateToolCallFromInput,
} from "../src/llm/transform.ts";
import * as Message from "../src/message/message.ts";
import * as Model from "../src/model/model.ts";
import { openAICodexTools } from "../src/providers/openai-codex/index.ts";
import { shortHash } from "../src/utils/hash.ts";
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

function makeAbortedToolCall(callID: string, text = "cancelled"): Message.ToolCallAbortedPart {
	return {
		type: "toolCall",
		callID,
		name: "test_tool",
		arguments: {},
		status: "aborted",
		result: { content: [{ type: "text", text }], isError: true },
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

function requireSignature(value: string | undefined): string {
	expect(value).toBeDefined();
	if (value === undefined) throw new Error("expected OpenAI reasoning signature");
	return value;
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
	it("passes user messages through unchanged", () => {
		const user = makeUserMessage("hello");
		expect(Message.transformMessages([user], sameModel)).toEqual([user]);
	});

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
		it("keeps thinking parts for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" },
			]);
		});

		it("keeps signature-only (redacted) thinking parts for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "", thinkingSignature: "sig-1", redacted: true }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-1", redacted: true },
			]);
		});

		it("downgrades thinking to text when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts).toEqual([
				{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" },
			]);

			expect(expectSingleAssistant(Message.transformMessages([assistant], otherModel)).parts).toEqual([
				{ type: "text", text: "reasoning here" },
			]);
		});

		it("drops empty thinking parts when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "  ", thinkingSignature: "sig-1", redacted: true }],
			});

			expect(expectSingleAssistant(Message.transformMessages([assistant], otherModel)).parts).toEqual([]);
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

		/** Gemini 3 enforces stricter validation on thought signatures than earlier versions.
		 * If a required thought signature is not returned when using Gemini 3 models, the model will return a 400 error.
		 * @see: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures
		 **/
		it("keeps thoughtSignature for the same model", () => {
			const toolCall: Message.ToolCallCompletedPart = {
				...makeCompletedToolCall("call-1"),
				thoughtSignature: "google-sig",
			};
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [toolCall] });

			expect(
				expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], sameModel))).thoughtSignature,
			).toBe("google-sig");
		});

		it("converts pending tool calls into synthetic skipped results", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makePendingToolCall("call-1")],
			});

			const part = expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], sameModel)));
			expect(part.status).toBe("skipped");
			if (part.status !== "skipped") throw new Error("unreachable");
			expect(part.result.isError).toBe(true);
			expect(part.result.content).toEqual([{ type: "text", text: "no result provided" }]);
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

		it("leaves completed tool calls untouched", () => {
			const completed = makeCompletedToolCall("call-1");
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [completed] });

			expect(expectSingleAssistant(Message.transformMessages([assistant], sameModel)).parts[0]).toEqual(completed);
		});

		it("leaves aborted tool calls untouched", () => {
			const aborted = makeAbortedToolCall("call-1");
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [aborted] });

			expect(expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], sameModel)))).toEqual(
				aborted,
			);
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

		// call ID normalization call back must not be invoked in case of same model.
		it("does not invoke the callback for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call/1")],
			});

			let calls = 0;
			Message.transformMessages([assistant], sameModel, (id) => {
				calls += 1;
				return id;
			});
			expect(calls).toBe(0);
		});
	});
});

describe("mapFinishReason", () => {
	/**
	 * Specific to ai-sdk wire protocol.
	 * @see: https://ai-sdk.dev/docs/ai-sdk-core/lifecycle-callbacks#finish-reason
	 */
	const cases: Array<[FinishReason | undefined, Message.StopReason]> = [
		["stop", "stop"],
		["length", "length"],
		["tool-calls", "toolUse"],
		["content-filter", "error"],
		["error", "error"],
		["other", "error"],
		[undefined, "stop"],
	];

	it.each(cases)("maps %s to %s", (reason, expected) => {
		expect(mapFinishReason(reason)).toBe(expected);
	});
});

describe("mapUsage", () => {
	const model = makeModel({
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	});

	it("returns zeros for undefined usage", () => {
		expect(mapUsage(undefined, model)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
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

	it("computes totalTokens from components when the provider omits it", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 100,
				outputTokens: 50,
				inputTokenDetails: { cacheReadTokens: 30 },
			}),
			model,
		);
		expect(usage.totalTokens).toBe(70 + 30 + 50);
	});

	it("calculates cost from per-million-token model pricing", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 2_000_000,
				outputTokens: 1_000_000,
				totalTokens: 3_000_000,
				inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 400_000 },
			}),
			model,
		);
		expect(usage.cost.input).toBeCloseTo(3);
		expect(usage.cost.output).toBeCloseTo(15);
		expect(usage.cost.cacheRead).toBeCloseTo(0.18);
		expect(usage.cost.cacheWrite).toBeCloseTo(1.5);
		expect(usage.cost.total).toBeCloseTo(3 + 15 + 0.18 + 1.5);
	});

	it("uses the highest matching request-wide input pricing tier", () => {
		const usage = mapUsage(
			makeLanguageModelUsage({
				inputTokens: 201,
				outputTokens: 1_000_000,
				totalTokens: 1_000_201,
				inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 101, cacheWriteTokens: 0 },
			}),
			makeModel({
				cost: {
					input: 1,
					output: 2,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [
						{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 },
						{ inputTokensAbove: 200, input: 4, output: 6, cacheRead: 0.4, cacheWrite: 5 },
					],
				},
			}),
		);
		expect(usage.cost.input).toBeCloseTo(0.0004);
		expect(usage.cost.output).toBeCloseTo(6);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0000404);
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

	it("converts tool definitions to an ai-sdk native ToolSet keyed by name", () => {
		const tool = Message.defineTool({
			name: "search",
			description: "Search documents",
			parameters: Type.Object({ query: Type.String() }),
		});

		const converted = convertTools([tool])?.search;
		expect(converted?.description).toBe("Search documents");
		expect(converted?.inputSchema).toBeDefined();
	});

	/**
	 * Note: keep this in sync with custom codex provider
	 */
	it("maps codex grammar tools through provider metadata without changing their object schema", () => {
		const tool = openAICodexTools.custom({
			name: "sample",
			description: "Generate a constrained sample",
			parameters: Type.Object({ payload: Type.String() }),
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});
		const converted = convertTools([tool], makeCodexModel({ compat: { supportsOpenAIGrammarTools: true } }))?.sample;
		expect(converted?.inputSchema).toBeDefined();
		expect(converted?.providerOptions).toEqual({
			"openai-codex": {
				grammar: {
					type: "grammar",
					format: "lark",
					definition: "start: /[a-z]+/",
					inputProperty: "payload",
				},
			},
		});
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

	it("ignores grammar constraints on non-Codex protocols", () => {
		const tool = openAICodexTools.custom({
			name: "sample",
			description: "Generate a sample",
			parameters: Type.Object({ payload: Type.String() }),
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});
		expect(convertTools([tool], sameModel)?.sample?.providerOptions).toBeUndefined();
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

	it("leaves tools with constrainedSampling disabled unchanged", () => {
		const tool = Message.defineTool({
			name: "plain",
			description: "Plain tool",
			parameters: Type.Object({ value: Type.String() }),
			constrainedSampling: false,
		});
		const converted = convertTools([tool], makeModel({ compat: { supportsStrictMode: true } }))?.plain;
		expect(converted?.strict).toBeUndefined();
		expect(converted?.providerOptions).toBeUndefined();
	});
});

/**
 * Note: keep in sync with openAI provider
 */
describe("encodeOpenAIReasoningSignature", () => {
	it("encodes item id and encrypted reasoning content", () => {
		expect(
			encodeOpenAIReasoningSignature({
				openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-reasoning" },
			}),
		).toBe(JSON.stringify({ itemId: "rs_1", reasoningEncryptedContent: "encrypted-reasoning" }));
	});

	it("preserves a null encrypted reasoning payload", () => {
		expect(encodeOpenAIReasoningSignature({ openai: { itemId: "rs_1", reasoningEncryptedContent: null } })).toBe(
			JSON.stringify({ itemId: "rs_1", reasoningEncryptedContent: null }),
		);
	});

	it("returns undefined for missing or invalid metadata", () => {
		expect(encodeOpenAIReasoningSignature(undefined)).toBeUndefined();
		expect(encodeOpenAIReasoningSignature("rs_1")).toBeUndefined();
		expect(encodeOpenAIReasoningSignature({})).toBeUndefined();
		expect(encodeOpenAIReasoningSignature({ openai: { itemId: 1 } })).toBeUndefined();
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

describe("createAssistantMessage", () => {
	it("creates an empty assistant message with zero usage for the given model", () => {
		const message = createAssistantMessage(sameModel);
		expect(message.role).toBe("assistant");
		expect(message.parts).toEqual([]);
		expect(message.stopReason).toBe("stop");
		expect(message.protocol).toBe(sameModel.protocol);
		expect(message.model).toBe(sameModel.id);
		expect(message.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
});

describe("toolCallFromPart", () => {
	it("maps a stream tool-call part onto a pending tool call", () => {
		const part: Extract<TextStreamPart<ToolSet>, { type: "tool-call" }> = {
			type: "tool-call",
			toolCallId: "call-1",
			toolName: "search",
			input: { query: "x" },
			dynamic: true,
		};
		expect(toolCallFromPart(part)).toMatchObject({
			type: "toolCall",
			callID: "call-1",
			name: "search",
			arguments: { query: "x" },
			status: "pending",
		});
	});

	it("uses an empty arguments object when the stream input is not an object", () => {
		const part: Extract<TextStreamPart<ToolSet>, { type: "tool-call" }> = {
			type: "tool-call",
			toolCallId: "call-1",
			toolName: "search",
			input: "not-an-object",
			dynamic: true,
		};
		expect(toolCallFromPart(part).arguments).toEqual({});
	});
});

describe("updateToolCallFromInput", () => {
	it("stores the partial JSON and parsed arguments on the streaming block", () => {
		const block = toolCallFromPart({
			type: "tool-call",
			toolCallId: "call-1",
			toolName: "search",
			input: {},
			dynamic: true,
		});
		updateToolCallFromInput(block, '{"query":"hello"');
		expect(block.partialJson).toBe('{"query":"hello"');
		expect(block.arguments).toEqual({ query: "hello" });
	});
});

describe("convertMessages", () => {
	it("converts user text messages", () => {
		expect(convertMessages({ messages: [makeUserMessage("hello")] }, imageModel)).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
	});

	it("drops whitespace-only user text and empty user messages", () => {
		expect(convertMessages({ messages: [makeUserMessage("  \n\t ")] }, imageModel)).toEqual([]);
	});

	it("includes user images only when the model supports image input", () => {
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
		expect(convertMessages({ messages: [userMessage] }, sameModel)[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "look" }],
		});
	});

	it("keeps image-only user messages when the model supports images", () => {
		expect(convertMessages({ messages: [pngUserMessage()] }, imageModel)).toMatchObject([
			{ role: "user", content: [{ type: "file", data: PNG, mediaType: "image/png" }] },
		]);
	});

	it("drops image-only user messages when the model does not support images", () => {
		expect(convertMessages({ messages: [pngUserMessage()] }, sameModel)).toEqual([]);
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

	it("drops assistant messages that errored or were aborted", () => {
		const errored = makeAssistantMessage(imageModel, {
			stopReason: "error",
			parts: [{ type: "text", text: "partial" }],
		});
		const aborted = makeAssistantMessage(imageModel, {
			stopReason: "aborted",
			parts: [{ type: "text", text: "partial" }],
		});

		const messages = convertMessages({ messages: [makeUserMessage("hi"), errored, aborted] }, imageModel);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	it("converts assistant text and skips empty text parts", () => {
		const assistant = makeAssistantMessage(imageModel, {
			parts: [
				{ type: "text", text: "answer" },
				{ type: "text", text: "   " },
			],
		});

		expect(convertMessages({ messages: [assistant] }, imageModel)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
	});

	/**
	 * FIXME: fix incoming:
	 *  - COD-39
	 *  - COD-38
	 */
	it("drops assistant image parts", () => {
		const assistant = makeAssistantMessage(imageModel, {
			parts: [{ type: "image", data: PNG, mimeType: "image/png" }],
		});
		expect(convertMessages({ messages: [assistant] }, imageModel)).toEqual([]);
	});

	it("emits reasoning parts with the provider signature for same-model replay", () => {
		const assistant = makeAssistantMessage(imageModel, {
			parts: [{ type: "thinking", thinking: "step by step", thinkingSignature: "sig-1" }],
		});

		expect(convertMessages({ messages: [assistant] }, imageModel)).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "step by step",
						providerOptions: { anthropic: { signature: "sig-1" } },
					},
				],
			},
		]);
	});

	it("converts cross-model thinking into assistant text", () => {
		const assistant = makeAssistantMessage(sameModel, {
			parts: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" }],
		});
		expect(convertMessages({ messages: [assistant] }, otherModel)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "plan" }] },
		]);
	});

	it("preserves OpenAI Responses reasoning metadata for same-model replay", () => {
		const openAIModel = makeOpenAIModel();
		const thinkingSignature = requireSignature(
			encodeOpenAIReasoningSignature({
				openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-reasoning" },
			}),
		);
		const assistant = makeAssistantMessage(openAIModel, {
			parts: [{ type: "thinking", thinking: "step by step", thinkingSignature }],
		});

		expect(convertMessages({ messages: [assistant] }, openAIModel)).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "step by step",
						providerOptions: {
							openai: {
								itemId: "rs_1",
								reasoningEncryptedContent: "encrypted-reasoning",
							},
						},
					},
				],
			},
		]);
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

	it("attaches Codex namespace and deferred-tool metadata", () => {
		const codexModel = makeCodexModel();
		const toolCall: Message.ToolCallCompletedPart = {
			...makeCompletedToolCall("call-1|fc-1", "search", [{ type: "text", text: "found" }], { query: "x" }),
			namespace: "workspace",
			addedToolNames: ["late_tool"],
		};
		const assistant = makeAssistantMessage(codexModel, { stopReason: "toolUse", parts: [toolCall] });
		const messages = convertMessages({ messages: [assistant] }, codexModel);

		expect(messages[0]).toMatchObject({
			role: "assistant",
			content: [{ providerOptions: { "openai-codex": { namespace: "workspace" } } }],
		});
		expect(messages[1]).toMatchObject({
			role: "tool",
			content: [{ providerOptions: { "openai-codex": { addedToolNames: ["late_tool"] } } }],
		});
	});

	it("omits item ids when replaying a prior Codex model id", () => {
		const target = makeCodexModel({ id: "gpt-5.6-luna" });
		const assistant = makeAssistantMessage(makeCodexModel({ id: "gpt-5.5" }), {
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

	// FIXME: incoming:
	// - COD-40
	it("does not put Google thoughtSignature on the wire", () => {
		const toolCall: Message.ToolCallCompletedPart = {
			...makeCompletedToolCall("call-1", "search", [{ type: "text", text: "ok" }], { query: "x" }),
			thoughtSignature: "google-sig",
		};
		const assistant = makeAssistantMessage(imageModel, { stopReason: "toolUse", parts: [toolCall] });
		expect(JSON.stringify(convertMessages({ messages: [assistant] }, imageModel))).not.toContain("google-sig");
	});

	it("converts completed tool calls into ai-sdk native tool-call plus tool-result messages", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makeCompletedToolCall("call-1", "search", [{ type: "text", text: "found it" }], { query: "x" })],
		});

		expect(convertMessages({ messages: [assistant] }, imageModel)).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: { query: "x" } }],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "search",
						output: { type: "text", value: "found it" },
					},
				],
			},
		]);
	});

	it("turns unresolved tool calls into skipped parts and wire-level error results", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makePendingToolCall("call-1", "search")],
		});

		const skipped = expectToolCall(expectSingleAssistant(Message.transformMessages([assistant], imageModel)));
		expect(skipped.status).toBe("skipped");

		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					output: { type: "error-text", value: "no result provided" },
				},
			],
		});
	});

	it("converts aborted tool calls to error-text output", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makeAbortedToolCall("call-1", "cancelled")],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [{ output: { type: "error-text", value: "cancelled" } }],
		});
	});

	it("converts error tool results to error-text output", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makeErrorToolCall("call-1", [{ type: "text", text: "request failed" }])],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [{ output: { type: "error-text", value: "request failed" } }],
		});
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

	it("uses only text from error results that also include images", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [
				makeErrorToolCall("call-1", [
					{ type: "text", text: "failed" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [{ output: { type: "error-text", value: "failed" } }],
		});
	});

	it("converts tool results with images to content output", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "screenshot", [
					{ type: "text", text: "the page" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [
				{
					output: {
						type: "content",
						value: [
							{ type: "text", text: "the page" },
							{ type: "file", data: { type: "data", data: PNG }, mediaType: "image/png" },
						],
					},
				},
			],
		});
	});

	it("converts image-only tool results to content output without a text part", () => {
		const assistant = makeAssistantMessage(imageModel, {
			stopReason: "toolUse",
			parts: [makeCompletedToolCall("call-1", "screenshot", [{ type: "image", data: PNG, mimeType: "image/png" }])],
		});
		expect(
			convertMessages({ messages: [assistant] }, imageModel).find((message) => message.role === "tool"),
		).toMatchObject({
			content: [
				{
					output: {
						type: "content",
						value: [{ type: "file", data: { type: "data", data: PNG }, mediaType: "image/png" }],
					},
				},
			],
		});
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
