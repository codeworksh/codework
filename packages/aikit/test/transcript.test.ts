/** Tool changes carried by transcript system messages, from the context down to the Responses wire. */
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import * as Message from "../src/message/message.ts";
import * as Transcript from "../src/message/transcript.ts";
import type * as Model from "../src/model/model.ts";
import { stream } from "../src/stream.ts";
import { makeUserMessage } from "./utils/fixtures.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_API_KEY,
	openAICodexModels,
	openAICodexSSEResponse,
	openAICodexTextEvents,
} from "./utils/openai-codex.ts";

type ResponsesBody = {
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

const system = (change: Pick<Message.SystemMessage, "toolsAdded" | "toolsRemoved">) =>
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

describe("Transcript", () => {
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
