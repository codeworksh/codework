import Type from "typebox";
import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { createOpenAICodex } from "../../src/providers/openai-codex/index.ts";
import { stream } from "../../src/stream.ts";
import { describeIfOpenAICodex, getOpenAICodexModel, openaiCodexOptions } from "../utils/llm.ts";

describeIfOpenAICodex("OpenAI Codex GPT-5.6", () => {
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

	it("enforces native JSON schema output over a real Codex round trip", { retry: 2, timeout: 120_000 }, async () => {
		const apiKey = process.env.OPENAI_CODEX_API_KEY;
		if (!apiKey) throw new Error("OPENAI_CODEX_API_KEY is required");
		const result = await createOpenAICodex({ apiKey })("gpt-5.6-luna").doGenerate({
			prompt: [
				{
					role: "user",
					content: [{ type: "text", text: "Return the lowercase word parity as the value." }],
				},
			],
			responseFormat: {
				type: "json",
				name: "codex_e2e_answer",
				schema: {
					type: "object",
					properties: { value: { type: "string", const: "parity" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
			providerOptions: { "openai-codex": { reasoningEffort: "low" } },
		});
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");

		expect(JSON.parse(text)).toEqual({ value: "parity" });
		expect(result.finishReason.unified).toBe("stop");
	});
});
