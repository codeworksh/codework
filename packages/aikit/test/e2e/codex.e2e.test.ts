import Type from "typebox";
import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { stream } from "../../src/stream.ts";
import { describeIfOpenAICodex, getOpenAICodexModel, getText, openaiCodexOptions } from "../utils/llm.ts";

describeIfOpenAICodex("OpenAI Codex GPT-5.6", () => {
	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("authenticates Luna with %s reasoning", { retry: 3, timeout: 120_000 }, async (requested, expected) => {
		const model = await getOpenAICodexModel("gpt-5.6-luna");
		expect(Model.clampThinkingLevel(model, requested)).toBe(expected);

		const response = await stream.complete(
			model,
			{
				messages: [
					Message.createUserMessage({
						role: "user",
						parts: [{ type: "text", text: "Reply with exactly AUTH_OK and nothing else." }],
						time: { created: Date.now() },
					}),
				],
			},
			openaiCodexOptions({ reasoning: requested }),
		);

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(getText(response).trim()).toBe("AUTH_OK");
	});

	it("streams a Luna grammar tool through standard Aikit tool events", { retry: 2, timeout: 120_000 }, async () => {
		const model = await getOpenAICodexModel("gpt-5.6-luna");
		const constrainedTool = Message.defineTool({
			name: "emit_token",
			description: "Emit the lowercase token requested by the user",
			parameters: Type.Object({ payload: Type.String() }),
			constrainedSampling: {
				type: "grammar",
				variants: { openai_lark: "start: /[a-z]+/" },
			},
		});
		const responseStream = stream(
			model,
			{
				messages: [
					Message.createUserMessage({
						role: "user",
						parts: [{ type: "text", text: "Call emit_token with exactly parity as its payload." }],
						time: { created: Date.now() },
					}),
				],
				tools: [constrainedTool],
			},
			openaiCodexOptions({ reasoning: "low", toolChoice: "required" }),
		);
		const eventTypes: string[] = [];
		for await (const event of responseStream) eventTypes.push(event.type);
		const response = await responseStream.result();
		const toolCall = response.parts.find((part): part is Message.ToolCall => part.type === "toolCall");

		expect(response.stopReason, response.errorMessage).toBe("toolUse");
		expect(toolCall?.name).toBe("emit_token");
		expect(toolCall?.arguments).toEqual({ payload: "parity" });
		expect(toolCall?.callID).toContain("|ctc_");
		expect(eventTypes).toContain("toolcall.start");
		expect(eventTypes).toContain("toolcall.delta");
		expect(eventTypes).toContain("toolcall.end");
		expect(eventTypes).toContain("toolcall.final");
	});
});
