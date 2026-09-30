import Type from "typebox";
import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { stream } from "../../src/stream.ts";
import {
	describeIfOpenAI,
	describeIfOpenAICodex,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	type StreamableModel,
} from "../utils/llm.ts";

/*
 * Histories that one model produced must replay on another turn, model, or
 * provider: orphaned reasoning items, tool calls paired with another
 * model's reasoning, and Codex `call|item` tool IDs are all rejected by the
 * Responses API with a 400 unless aikit rewrites them.
 */

const doubleTool = Message.defineTool({
	name: "double_number",
	description: "Doubles a number and returns the result",
	parameters: Type.Object({ value: Type.Number({ description: "A number to double" }) }),
});

type Target = { model: StreamableModel; options: object };

function user(text: string): Message.UserMessage {
	return Message.createUserMessage({ role: "user", time: { created: Date.now() }, parts: [{ type: "text", text }] });
}

/** A real turn that calls double_number, with the tool call completed as 42. */
async function toolTurn({ model, options }: Target): Promise<Message.AssistantMessage> {
	const response = await stream.complete(
		model,
		{
			systemPrompt: "You are a helpful assistant. Always use the tool when asked.",
			messages: [user("Use the double_number tool to double 21.")],
			tools: [doubleTool],
		},
		options,
	);
	expect(response.stopReason, response.errorMessage).toBe("toolUse");
	return {
		...response,
		parts: response.parts.map((part) =>
			part.type === "toolCall" && part.status === "pending"
				? { ...part, status: "completed", result: { content: [{ type: "text", text: "42" }], isError: false } }
				: part,
		),
	};
}

/** Continue a history on `target` and expect a normal answer mentioning 42. */
async function expectContinues(target: Target, history: Message.AssistantMessage) {
	const response = await stream.complete(
		target.model,
		{
			systemPrompt: "You are a helpful assistant. Answer concisely.",
			messages: [
				user("Use the double_number tool to double 21."),
				history,
				user("What was the result? Number only."),
			],
			tools: [doubleTool],
		},
		target.options,
	);
	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response)).toContain("42");
}

/** A turn aborted after reasoning: only the signed thinking part survives. */
async function expectAbortedReasoningReplays({ model, options }: Target) {
	// Trivial tool calls skip reasoning; a multiplication at high effort reliably reasons.
	const question = user("What is 17 multiplied by 19? Think it through.");
	const first = await stream.complete(model, { messages: [question] }, options);
	const thinking = first.parts.find((part) => part.type === "thinking" && part.thinkingSignature);
	expect(thinking, "expected signed reasoning").toBeDefined();

	const response = await stream.complete(
		model,
		{
			systemPrompt: "You are a helpful assistant.",
			messages: [
				question,
				{ ...first, parts: thinking ? [thinking] : [], stopReason: "aborted" },
				user("Say hello to confirm you can continue."),
			],
		},
		options,
	);
	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response).length).toBeGreaterThan(0);
}

// High, so every model, nano included, emits a signed reasoning item when it reasons.
const openai = async (id: string): Promise<Target> => ({
	model: await getOpenAIModel(id),
	options: openaiOptions({ reasoning: "high" }),
});
const codex = async (id: string): Promise<Target> => ({
	model: await getOpenAICodexModel(id),
	options: openaiCodexOptions({ reasoning: "high" }),
});

/** The next model in the matrix, wrapping around, so every model hands off to a different one. */
function neighbour<T>(models: readonly T[], id: T): T {
	return models[(models.indexOf(id) + 1) % models.length]!;
}

describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI handoff (%s)", (modelId) => {
	it("replays a reasoning-only aborted turn", { retry: 2, timeout: 180_000 }, async () => {
		await expectAbortedReasoningReplays(await openai(modelId));
	});

	it(`continues a tool turn on ${neighbour(OPENAI_E2E_MODELS, modelId)}`, { retry: 2, timeout: 180_000 }, async () => {
		const history = await toolTurn(await openai(modelId));
		await expectContinues(await openai(neighbour(OPENAI_E2E_MODELS, modelId)), history);
	});
});

describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex handoff (%s)", (modelId) => {
	it("replays a reasoning-only aborted turn", { retry: 2, timeout: 180_000 }, async () => {
		await expectAbortedReasoningReplays(await codex(modelId));
	});

	it(
		`continues a tool turn on ${neighbour(OPENAI_CODEX_E2E_MODELS, modelId)}`,
		{ retry: 2, timeout: 180_000 },
		async () => {
			const history = await toolTurn(await codex(modelId));
			await expectContinues(await codex(neighbour(OPENAI_CODEX_E2E_MODELS, modelId)), history);
		},
	);
});

// Codex and OpenAI share model IDs; histories must cross between the two providers both ways.
describeIfOpenAI.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex <-> OpenAI handoff (%s)", (modelId) => {
	it.runIf(process.env.OPENAI_CODEX_API_KEY)(
		"continues a Codex tool turn on OpenAI",
		{ retry: 2, timeout: 180_000 },
		async () => {
			const history = await toolTurn(await codex(modelId));
			expect(history.parts.find((part) => part.type === "toolCall")?.callID).toContain("|");
			await expectContinues(await openai(modelId), history);
		},
	);

	it.runIf(process.env.OPENAI_CODEX_API_KEY)(
		"continues an OpenAI tool turn on Codex",
		{ retry: 2, timeout: 180_000 },
		async () => {
			const history = await toolTurn(await openai(modelId));
			await expectContinues(await codex(modelId), history);
		},
	);
});
