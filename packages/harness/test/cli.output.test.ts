import { Message } from "@codeworksh/aikit";
import { describe, expect, it } from "vite-plus/test";
import { addUsage, emptyUsage, header, usage } from "../src/cli/output.ts";

const message = (input: {
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly reasoning?: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
}) =>
	Message.createAssistantMessage({
		messageId: crypto.randomUUID(),
		role: "assistant",
		protocol: "openai",
		provider: { id: "openai", name: "OpenAI", source: "custom", env: [] },
		model: input.model,
		usage: {
			input: input.input,
			output: input.output,
			...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
			cacheRead: input.cacheRead,
			cacheWrite: input.cacheWrite,
			totalTokens: input.totalTokens,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: input.cost,
			},
		},
		stopReason: "stop",
		time: { created: 0, completed: 1 },
		parts: [{ type: "text", text: "done" }],
	});

describe("CLI output", () => {
	it("renders session context before a labeled response divider", () => {
		const output = header({ sessionId: "ses_test", sandbox: "daytona", directory: "/workspace", columns: 48 });

		expect(output).toContain("session  ses_test");
		expect(output).toContain("sandbox  daytona · /workspace");
		expect(output).toContain("── response ─");
	});

	it("aggregates model usage across tool-continuation turns", () => {
		const first = addUsage(
			emptyUsage,
			message({
				model: "gpt-5.6-luna",
				input: 1_000,
				output: 100,
				cacheRead: 800,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: 0.001,
			}),
		);
		const summary = addUsage(
			first,
			message({
				model: "gpt-5.6-luna",
				input: 2_000,
				output: 200,
				reasoning: 50,
				cacheRead: 1_500,
				cacheWrite: 10,
				totalTokens: 2_200,
				cost: 0.002,
			}),
		);
		const output = usage(summary, 72);

		expect(output).toContain("model    openai/gpt-5.6-luna");
		expect(output).toContain("tokens   3,000 input · 300 output · 50 reasoning · 3,300 total");
		expect(output).toContain("cache    2,300 read · 10 write");
		expect(output).toContain("cost     $0.003000 · 2 turns");
	});
});
