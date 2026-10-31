/** Prompt and tool changes carried by transcript system messages, from the context down to the Responses and Anthropic wires. */
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import * as Message from "../src/message/message.ts";
import * as Transcript from "../src/message/transcript.ts";
import type * as Model from "../src/model/model.ts";
import { stream } from "../src/stream.ts";
import { fakeAnthropic, textReply } from "./utils/anthropic.ts";
import { makeAssistantMessage, makeCompletedToolCall, makeModel, makeUserMessage } from "./utils/fixtures.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_API_KEY,
	openAICodexModels,
	openAICodexSSEResponse,
	openAICodexTextEvents,
} from "./utils/openai-codex.ts";

type ResponsesBody = {
	instructions?: string;
	tools?: Array<{ name: string; description?: string }>;
	input: Array<{
		type?: string;
		role?: string;
		content?: unknown;
		tools?: Array<{ name: string; description?: string }>;
	}>;
};

function tool(name: string, description = `${name} tool`): Message.Tool {
	return { name, description, parameters: Type.Object({}) };
}

const baseTool = tool("base_tool");
const dropTool = tool("drop_tool");
const lateTool = tool("late_tool");

const system = (change: Omit<Message.SystemMessage, "messageId" | "role" | "time">) =>
	Message.createSystemMessage(change);

const changesModel = () => openAICodexModels()["gpt-6-luna"]!;
const additionsModel = (): Model.Info => {
	const model = changesModel();
	return { ...model, compat: { ...model.compat, supportsAdditionalTools: false, supportsToolSearch: true } };
};

async function capture(model: Model.Info, context: Message.Context): Promise<ResponsesBody> {
	const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
	const result = await stream.complete(model, context, {
		apiKey: OPENAI_CODEX_TEST_API_KEY,
		factoryOptions: { fetch },
	});
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return body() as ResponsesBody;
}

/**
 * One request after each step: the initial tools, the removal of drop_tool, then two loads.
 * Returns the request before the removal followed by the one after each later step.
 */
async function captureToolHistory(model: Model.Info): Promise<ResponsesBody[]> {
	const steps: Message.Message[][] = [
		[makeUserMessage("first")],
		[system({ toolsRemoved: [{ name: "drop_tool" }] }), makeUserMessage("after removal")],
		[system({ toolsAdded: [lateTool] }), makeUserMessage("after first load")],
		[system({ toolsAdded: [tool("later_tool")] }), makeUserMessage("after second load")],
	];
	const messages: Message.Message[] = [];
	const bodies: ResponsesBody[] = [];
	for (const step of steps) {
		messages.push(...step);
		bodies.push(
			await capture(model, { systemPrompt: "base prompt", tools: [baseTool, dropTool], messages: [...messages] }),
		);
	}
	return bodies;
}

/** Every request's input starts with the previous request's input, so the cached prefix holds. */
function expectGrowingPrefix(inputs: ReadonlyArray<ResponsesBody["input"]>): void {
	for (let index = 1; index < inputs.length; index++) {
		const previous = inputs[index - 1] ?? [];
		expect(inputs[index]?.slice(0, previous.length)).toEqual(previous);
	}
}

const declared = (body: ResponsesBody | undefined, type: string) =>
	body?.input.filter((item) => item.type === type).map((item) => item.tools?.map(({ name }) => name));
const notices = (body: ResponsesBody | undefined, text: string) =>
	body?.input.flatMap((item) =>
		typeof item.content === "string" && item.content.includes(text) ? [item.content] : [],
	);

describe("transcript tool changes on the Responses wire", () => {
	it("keeps the request prefix across a removal and later loads", async () => {
		const bodies = await captureToolHistory(changesModel());

		for (const body of bodies) expect(body.tools).toBeUndefined();
		expectGrowingPrefix(bodies.map((body) => body.input));
		const last = bodies.at(-1);
		expect(declared(last, "additional_tools")).toEqual([["base_tool", "drop_tool"], ["late_tool"], ["later_tool"]]);
		expect(notices(last, "no longer available. Do not call them:\n- drop_tool")).toHaveLength(1);
		// Each later load restates the tools that are still unavailable.
		expect(notices(last, "incremental tools update")).toEqual([
			expect.stringContaining("\nStill unavailable: drop_tool."),
			expect.stringContaining("\nStill unavailable: drop_tool."),
		]);
	});

	it("moves the tool search boundary once on a removal and keeps the prefix across later loads", async () => {
		const [beforeRemoval, ...afterRemoval] = await captureToolHistory(additionsModel());

		expect(beforeRemoval?.tools?.map(({ name }) => name)).toEqual(["base_tool", "drop_tool"]);
		for (const body of afterRemoval) expect(body.tools?.map(({ name }) => name)).toEqual(["base_tool"]);
		expectGrowingPrefix(afterRemoval.map((body) => body.input));
		expect(declared(afterRemoval.at(-1), "tool_search_output")).toEqual([["late_tool"], ["later_tool"]]);
	});

	it("redefines a tool in place instead of announcing a removal", async () => {
		const body = await capture(changesModel(), {
			tools: [baseTool],
			messages: [
				makeUserMessage("before"),
				system({ toolsRemoved: [{ name: "base_tool" }], toolsAdded: [tool("base_tool", "changed")] }),
			],
		});

		expect(body.tools).toBeUndefined();
		expect(body.input).toMatchObject([
			{ type: "additional_tools", tools: [{ name: "base_tool", description: "base_tool tool" }] },
			{ role: "user" },
			{ role: "developer", content: expect.stringContaining("latest definition replaces the earlier one") },
			{ type: "additional_tools", tools: [{ name: "base_tool", description: "changed" }] },
		]);
		expect(body.input).toHaveLength(4);
	});

	it("stops listing a tool as unavailable once it is declared again", async () => {
		const body = await capture(changesModel(), {
			tools: [baseTool, dropTool],
			messages: [
				system({ toolsRemoved: [{ name: "drop_tool" }] }),
				system({ toolsAdded: [dropTool] }),
				makeUserMessage("go"),
			],
		});

		const [notice] = notices(body, "incremental tools update") ?? [];
		expect(notice).toBeDefined();
		expect(notice).not.toContain("Still unavailable");
		expect(body.input.at(-2)).toMatchObject({ type: "additional_tools", tools: [{ name: "drop_tool" }] });
	});

	it("announces a removal after the additions of the same change", async () => {
		const body = await capture(changesModel(), {
			tools: [baseTool, dropTool],
			messages: [system({ toolsAdded: [lateTool], toolsRemoved: [{ name: "drop_tool" }] }), makeUserMessage("go")],
		});

		const [notice, ...rest] = body.input.slice(-4);
		expect(notice?.content).toEqual(expect.stringContaining("incremental tools update"));
		expect(notice?.content).not.toEqual(expect.stringContaining("Still unavailable"));
		expect(rest).toMatchObject([
			{ type: "additional_tools", tools: [{ name: "late_tool" }] },
			{ content: expect.stringContaining("no longer available. Do not call them:\n- drop_tool") },
			{ role: "user" },
		]);
	});

	it("sends the current tools top-level on a model without in-place declarations", async () => {
		const body = await capture(openAICodexModels()["gpt-5.3-codex-spark"]!, {
			tools: [baseTool, dropTool],
			messages: [
				makeUserMessage("before"),
				system({ toolsAdded: [lateTool], toolsRemoved: [{ name: "drop_tool" }] }),
			],
		});

		expect(body.tools?.map(({ name }) => name)).toEqual(["base_tool", "late_tool"]);
		expect(body.input.some((item) => item.type === "additional_tools" || item.type === "tool_search_call")).toBe(
			false,
		);
	});
});

describe("transcript prompt changes on the Responses wire", () => {
	const update = system({ sections: { codeword: "<codeword>bravo</codeword>" } });
	const steps = (model: Model.Info) =>
		Promise.all(
			[[makeUserMessage("first")], [makeUserMessage("first"), update, makeUserMessage("second")]].map((messages) =>
				capture(model, {
					systemPrompt: "base prompt",
					messages: [system({ sections: { codeword: "<codeword>alpha</codeword>" } }), ...messages],
				}),
			),
		);

	it("keeps the leading prompt and sends a section change in place", async () => {
		const [before, after] = await steps(changesModel());

		expect(before?.instructions).toBe("base prompt");
		expect(after?.instructions).toBe("base prompt");
		expectGrowingPrefix([before?.input ?? [], after?.input ?? []]);
		expect(after?.input).toMatchObject([
			{ role: "developer", content: 'Updated system prompt section "codeword":\n\n<codeword>alpha</codeword>' },
			{ role: "user" },
			{ role: "developer", content: 'Updated system prompt section "codeword":\n\n<codeword>bravo</codeword>' },
			{ role: "user" },
		]);
	});

	it("folds every change into the leading prompt on a model without mid-conversation system messages", async () => {
		const [, after] = await steps(openAICodexModels()["gpt-5.3-codex-spark"]!);

		expect(after?.instructions).toBe("base prompt\n\n<codeword>bravo</codeword>");
		expect(after?.input.map((item) => item.role)).toEqual(["user", "user"]);
	});

	it("sends a prompt update and a tool removal of one message as one developer message", async () => {
		const body = await capture(changesModel(), {
			systemPrompt: "base prompt",
			tools: [baseTool, dropTool],
			messages: [
				makeUserMessage("first"),
				system({ content: "Be brief.", toolsRemoved: [{ name: "drop_tool" }] }),
				makeUserMessage("second"),
			],
		});

		expect(body.input.slice(-2)).toMatchObject([
			{
				role: "developer",
				content: "Be brief.\n\nThe following tools are no longer available. Do not call them:\n- drop_tool",
			},
			{ role: "user" },
		]);
	});
});

describe("Transcript", () => {
	const context: Message.Context = {
		systemPrompt: "base",
		messages: [
			system({ sections: { a: "<a>1</a>", b: "<b>1</b>" } }),
			makeUserMessage("hello"),
			system({ content: "also do this" }),
			system({ sections: { a: "<a>2</a>", b: null, c: "<c>1</c>" } }),
		],
	};

	it("replays content and sections into the current prompt", () => {
		expect(Transcript.getCurrentSystemPrompt(context)).toBe("base\n\nalso do this\n\n<a>2</a>\n\n<c>1</c>");
		expect(Transcript.getCurrentSystemPrompt({ messages: [makeUserMessage("hi")] })).toBe("");
	});

	it("replays a late full patch on a transcript without a prompt as the prompt", () => {
		const late = { messages: [makeUserMessage("old"), system({ sections: { preamble: "You are pi." } })] };
		expect(Transcript.getCurrentSystemPrompt(late)).toBe("You are pi.");
	});

	it("appends a removed section added again", () => {
		const readded = {
			messages: [
				system({ sections: { a: "<a/>", b: "<b/>" } }),
				system({ sections: { a: null } }),
				system({ sections: { a: "<a>again</a>" } }),
			],
		};
		expect(Transcript.getCurrentSystemPrompt(readded)).toBe("<b/>\n\n<a>again</a>");
	});

	it("renders complete prompts and framed updates", () => {
		expect(Transcript.renderSystemPrompt({ content: "base", sections: { a: "<a>1</a>", b: null } })).toBe(
			"base\n\n<a>1</a>",
		);
		expect(Transcript.renderSystemPromptUpdate({ sections: { a: "<a>2</a>", b: null } })).toBe(
			'Updated system prompt section "a":\n\n<a>2</a>\n\nRemoved system prompt section "b".',
		);
	});

	it("resolves the leading prompt per transport", () => {
		expect(Transcript.resolveTranscriptPrompt(context, false)).toEqual({
			systemPrompt: "base\n\nalso do this\n\n<a>2</a>\n\n<c>1</c>",
			foldedSystemMessages: 3,
		});
		expect(Transcript.resolveTranscriptPrompt(context, true)).toEqual({
			systemPrompt: "base",
			foldedSystemMessages: 0,
		});
		// Without a prompt or initial tools, a leading system message is the prompt.
		const { systemPrompt: _, ...headless } = context;
		expect(Transcript.resolveTranscriptPrompt(headless, true)).toEqual({
			systemPrompt: "<a>1</a>\n\n<b>1</b>",
			foldedSystemMessages: 1,
		});
		expect(Transcript.resolveTranscriptPrompt({ ...headless, tools: [baseTool] }, true)).toEqual({
			systemPrompt: "",
			foldedSystemMessages: 0,
		});
	});

	it("resolves the top-level tool boundary per transport", () => {
		const messages = [
			system({ toolsRemoved: [{ name: "drop_tool" }] }),
			system({ toolsAdded: [dropTool] }),
			system({ toolsAdded: [tool("late_tool", "x")] }),
			system({ toolsAdded: [tool("late_tool", "y")] }),
		];
		const context = (count: number) => ({ tools: [baseTool, dropTool], messages: messages.slice(0, count) });

		expect(Transcript.resolveTranscriptTools(context(1), "additions")).toEqual({
			requestTools: [baseTool],
			initialToolsInPlace: false,
			foldedSystemMessages: 1,
		});
		// A removed tool declared again moves the boundary; the new late_tool after it stays in place.
		expect(Transcript.resolveTranscriptTools(context(3), "additions")).toEqual({
			requestTools: [baseTool, dropTool],
			initialToolsInPlace: false,
			foldedSystemMessages: 2,
		});
		// The redefinition of late_tool moves the boundary to its message.
		expect(Transcript.resolveTranscriptTools(context(4), "additions")).toEqual({
			requestTools: [baseTool, dropTool, tool("late_tool", "y")],
			initialToolsInPlace: false,
			foldedSystemMessages: 4,
		});
		expect(Transcript.resolveTranscriptTools(context(4), "changes")).toEqual({
			requestTools: [],
			initialToolsInPlace: true,
			foldedSystemMessages: 0,
		});
		expect(Transcript.resolveTranscriptTools(context(4), "none")).toEqual({
			requestTools: [baseTool, dropTool, tool("late_tool", "y")],
			initialToolsInPlace: false,
			foldedSystemMessages: 4,
		});
	});

	it("treats a changed definition as a removal plus an addition", () => {
		const changed = tool("base_tool", "changed");
		expect(Transcript.getToolStateChanges([baseTool, dropTool], [changed, lateTool])).toEqual({
			toolsAdded: [changed, lateTool],
			toolsRemoved: [{ name: "base_tool" }, { name: "drop_tool" }],
		});
		// Typebox symbol keys are not part of the declaration.
		const plain: Message.Tool = {
			name: "base_tool",
			description: "base_tool tool",
			parameters: { type: "object", properties: {} },
		};
		expect(Transcript.declarationsEqual(baseTool, plain)).toBe(true);
	});

	it("keeps removed tools among the declared ones, latest definition winning", () => {
		const changed = tool("base_tool", "changed");
		expect(
			Transcript.getDeclaredTools({
				tools: [baseTool],
				messages: [
					system({ toolsRemoved: [{ name: "base_tool" }], toolsAdded: [changed] }),
					system({ toolsAdded: [lateTool] }),
				],
			}),
		).toEqual([changed, lateTool]);
	});
});

describe("transcript prompt changes on the Anthropic wire", () => {
	type AnthropicBody = {
		system?: Array<{ text: string }>;
		messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
	};
	const claude = (inPlace: boolean) =>
		makeModel({ npm: "@ai-sdk/anthropic", compat: { supportsMidConvoSystemMessages: inPlace } });
	const wire = async (model: Model.Info) => {
		const server = fakeAnthropic(textReply);
		await stream(
			model,
			{
				systemPrompt: "base prompt",
				messages: [
					makeUserMessage("first"),
					system({ sections: { codeword: "<codeword>alpha</codeword>" } }),
					makeAssistantMessage(model, { stopReason: "toolUse", parts: [makeCompletedToolCall("call-1")] }),
					system({ sections: { codeword: "<codeword>bravo</codeword>" } }),
					makeUserMessage("second"),
				],
			},
			{ apiKey: "test-key", factoryOptions: { fetch: server.fetch } },
		).result();
		const body = server.body() as AnthropicBody;
		return {
			system: body.system?.map((part) => part.text),
			messages: body.messages.map((message) => [
				message.role,
				message.content.map((part) => part.text ?? part.type).join(" | "),
			]),
		};
	};

	it("joins a declaration before the first reply to the leading prompt and holds a later one past the tool result and prompt", async () => {
		expect(await wire(claude(true))).toEqual({
			system: ["base prompt", 'Updated system prompt section "codeword":\n\n<codeword>alpha</codeword>'],
			messages: [
				["user", "first"],
				["assistant", "tool_use"],
				["user", "tool_result | second"],
				["system", 'Updated system prompt section "codeword":\n\n<codeword>bravo</codeword>'],
			],
		});
	});

	it("folds every change into the leading prompt on a model without mid-conversation system messages", async () => {
		expect(await wire(claude(false))).toEqual({
			system: ["base prompt\n\n<codeword>bravo</codeword>"],
			messages: [
				["user", "first"],
				["assistant", "tool_use"],
				["user", "tool_result | second"],
			],
		});
	});
});

describe("transcript tool changes on the Anthropic wire", () => {
	type ToolsBody = {
		tools?: Array<{ name: string; defer_loading?: boolean }>;
		messages: Array<{ role: string; content: Array<{ type: string; text?: string; tool?: { name: string } }> }>;
	};
	const claude = makeModel({
		npm: "@ai-sdk/anthropic",
		compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
	});
	const capture = async (messages: Message.Message[]) => {
		const server = fakeAnthropic(textReply);
		await stream(
			claude,
			{
				systemPrompt: "base prompt",
				tools: [baseTool, dropTool],
				deferredTools: [lateTool, tool("spare_tool")],
				messages,
			},
			{ apiKey: "test-key", factoryOptions: { fetch: server.fetch } },
		).result();
		const body = server.body() as ToolsBody;
		return {
			tools: body.tools?.map((one) => `${one.name}${one.defer_loading ? " (deferred)" : ""}`),
			messages: body.messages.map((message) => [
				message.role,
				message.content
					.map((part) => (part.tool ? `${part.type} ${part.tool.name}` : (part.text ?? part.type)))
					.join(" | "),
			]),
		};
	};
	const first = [makeUserMessage("first"), system({ toolsAdded: [tool("early_tool")] })];
	const toolTurn = makeAssistantMessage(claude, { stopReason: "toolUse", parts: [makeCompletedToolCall("call-1")] });
	const later = [
		toolTurn,
		system({ toolsAdded: [lateTool], toolsRemoved: [{ name: "drop_tool" }] }),
		makeUserMessage("second"),
	];

	it("declares the catalog deferred up front and references a later change", async () => {
		const before = await capture(first);
		const after = await capture([...first, ...later]);

		// Every tool is declared from the first request on, so a later change keeps the list as it was.
		expect(after.tools).toEqual(before.tools);
		expect(after.tools).toEqual([
			"base_tool",
			"drop_tool",
			"early_tool",
			"late_tool (deferred)",
			"spare_tool (deferred)",
		]);
		expect(after.messages).toEqual([
			["user", "first"],
			["assistant", "tool_use"],
			["user", "tool_result | second"],
			["system", "tool_removal drop_tool | tool_addition late_tool"],
		]);
	});
});
