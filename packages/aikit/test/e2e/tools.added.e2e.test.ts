import { zstdDecompressSync } from "node:zlib";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { llm } from "../../src/llm.ts";
import * as Message from "../../src/message/message.ts";
import {
	getGitHubCopilotApiKey,
	GitHubCopilotOAuthClient,
	gitHubCopilotBaseUrl,
} from "../../src/oauth/github/copilot.ts";
import { complete } from "../../src/stream.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfGoogle,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getGoogleModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	googleOptions,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm.ts";

const baseTool = Message.defineTool({
	name: "base_tool",
	description: "Starts the task. Call it first.",
	parameters: Type.Object({}),
});

const lateTool = Message.defineTool({
	name: "late_tool",
	description: "Finishes the task. Pass the code base_tool returned.",
	parameters: Type.Object({ code: Type.String() }),
});

const copilotApiKey = await getGitHubCopilotApiKey();
const copilotBaseUrl = gitHubCopilotBaseUrl((await new GitHubCopilotOAuthClient().getCredentials()) ?? undefined);
const describeIfGitHubCopilot = copilotApiKey ? describe : describe.skip;

async function getCopilotModel(modelId: string): Promise<StreamableModel> {
	const model = await llm("github-copilot", modelId);
	if (!model) throw new Error(`expected github-copilot model ${modelId}`);
	return model as StreamableModel;
}

/** Records each request body the provider sends (Codex zstd-compresses its own), then forwards it. */
function recordRequests() {
	const bodies: Array<Record<string, unknown>> = [];
	const record: typeof fetch = (input, init) => {
		const body = init?.body;
		if (typeof body === "string") bodies.push(JSON.parse(body));
		else if (body instanceof Uint8Array) bodies.push(JSON.parse(zstdDecompressSync(body).toString()));
		return fetch(input, init);
	};
	return { bodies, fetch: record };
}

function toolName(tool: unknown): string | undefined {
	if (typeof tool !== "object" || tool === null) return;
	const record = tool as { name?: unknown; function?: { name?: unknown } };
	if (typeof record.name === "string") return record.name;
	if (typeof record.function?.name === "string") return record.function.name;
}

/** Names of the tools in the request's top-level tool list, across wire formats. */
function topLevelTools(body: Record<string, unknown>): string[] {
	const tools = (body.tools ?? []) as unknown[];
	return tools.flatMap((tool) => {
		const declarations = (tool as { functionDeclarations?: unknown[] }).functionDeclarations;
		return (declarations ?? [tool]).map(toolName).filter((name): name is string => name !== undefined);
	});
}

/** The Responses input as one line per item, so where each tool was declared stays visible. */
function responsesLayout(body: Record<string, unknown>): string[] | undefined {
	const input = body.input as Array<Record<string, unknown>> | undefined;
	if (!Array.isArray(input)) return;
	return input.flatMap((item) => {
		if (item.type === "reasoning") return [];
		if (item.type === "additional_tools" || item.type === "tool_search_output") {
			return [`${item.type}: ${(item.tools as unknown[]).map(toolName).join(", ")}`];
		}
		if (item.type === "function_call") return [`function_call: ${String(item.name)}`];
		if (typeof item.type === "string") return [item.type];
		const content = typeof item.content === "string" ? `: ${item.content.split("\n")[0]}` : "";
		return [`${String(item.role)}${content}`];
	});
}

/*
 * A tool added mid-conversation is callable on the next request. The first turn only has
 * `base_tool`; after its result a system message adds `late_tool` and removes `base_tool`,
 * and the second turn must call `late_tool`. The artifact records where each tool went.
 */
async function callToolAddedMidConversation(model: StreamableModel, options: object, name: string) {
	const context: Message.Context = {
		systemPrompt: "You complete tasks by calling tools. Never answer in text when a tool can do the step.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Call base_tool now. Once it returns, call late_tool with the code it gave you.",
					},
				],
				time: { created: Date.now() },
			}),
		],
		tools: [baseTool],
	};

	const first = await complete(model, context, options as never);
	expect(first.stopReason, first.errorMessage).toBe("toolUse");
	const call = first.parts.find((part): part is Message.ToolCall => part.type === "toolCall");
	if (!call || call.name !== "base_tool") throw new Error(`expected a base_tool call, received ${call?.name}`);
	context.messages.push({
		...first,
		parts: first.parts.map((part) =>
			part === call
				? {
						...call,
						status: "completed",
						result: {
							content: [{ type: "text", text: "Code: 4711. late_tool is now available; call it next." }],
							isError: false,
						},
						time: { ...call.time, end: Date.now() },
					}
				: part,
		),
	});
	context.messages.push(
		Message.createSystemMessage({ toolsAdded: [lateTool], toolsRemoved: [{ name: "base_tool" }] }),
	);

	const requests = recordRequests();
	const second = await complete(model, context, {
		...options,
		factoryOptions: { ...(options as { factoryOptions?: object }).factoryOptions, fetch: requests.fetch },
	} as never);
	expect(second.stopReason, second.errorMessage).toBe("toolUse");
	const called = second.parts.filter((part): part is Message.ToolCall => part.type === "toolCall");
	// Some models call it more than once in parallel; every call must be the added tool.
	expect(called.length).toBeGreaterThan(0);
	expect(new Set(called.map((part) => part.name))).toEqual(new Set(["late_tool"]));
	expect(called[0]?.arguments).toMatchObject({ code: expect.stringContaining("4711") });

	const body = requests.bodies.at(-1);
	if (!body) throw new Error("expected a recorded request");
	const layout = responsesLayout(body);
	const artifact = { topLevelTools: topLevelTools(body), ...(layout ? { input: layout } : {}), called: "late_tool" };
	await expect(JSON.stringify(artifact, null, "\t")).toMatchFileSnapshot(`./__artifacts__/tools-added.${name}.json`);
	return artifact;
}

describe("Tools added mid-conversation", () => {
	describeIfOpenAICodex("OpenAI Codex provider", () => {
		it("gpt-6-luna declares tool changes in place", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel("gpt-6-luna");
			const artifact = await callToolAddedMidConversation(model, openaiCodexOptions(), "openai-codex");
			expect(artifact.topLevelTools).toEqual([]);
		});
	});

	describeIfAnthropic("Anthropic provider", () => {
		it(ANTHROPIC_E2E_MODELS[0], { retry: 2, timeout: 120_000 }, async () => {
			const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
			const artifact = await callToolAddedMidConversation(model, anthropicOptions({ maxTokens: 512 }), "anthropic");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});
	});

	describeIfOpenAI("OpenAI provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAIModel("gpt-6-luna");
			const artifact = await callToolAddedMidConversation(model, openaiOptions(), "openai");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});
	});

	describeIfGoogle("Google provider", () => {
		it("gemini-3.5-flash", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getGoogleModel();
			const artifact = await callToolAddedMidConversation(model, googleOptions(), "google");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});
	});

	describeIfGitHubCopilot("GitHub Copilot provider", () => {
		const options = (extras: object = {}) => ({ apiKey: copilotApiKey!, baseURL: copilotBaseUrl, ...extras });

		it("gpt-6-luna declares tool changes in place on /responses", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getCopilotModel("gpt-6-luna");
			const artifact = await callToolAddedMidConversation(
				model,
				options({ reasoning: "low" }),
				"github-copilot-responses",
			);
			expect(artifact.topLevelTools).toEqual([]);
		});

		it("claude-sonnet-5.5 takes the current tools on /v1/messages", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getCopilotModel("claude-sonnet-5.5");
			// Thinking off: this Claude cannot disable thinking, so the request leaves it out.
			const artifact = await callToolAddedMidConversation(model, options(), "github-copilot-messages");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});

		it("gemini-3.8-flash takes the current tools on /chat/completions", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getCopilotModel("gemini-3.8-flash");
			const artifact = await callToolAddedMidConversation(model, options(), "github-copilot-chat");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});
	});

	describeIfOpenRouter("OpenRouter provider", () => {
		it("deepseek/deepseek-v4.1-flash", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenRouterModel("deepseek/deepseek-v4.1-flash");
			const artifact = await callToolAddedMidConversation(model, openrouterOptions(), "openrouter");
			expect(artifact.topLevelTools).toEqual(["late_tool"]);
		});
	});
});
