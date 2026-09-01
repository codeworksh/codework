import { Message } from "@codeworksh/aikit";
import { describe, expect, it } from "vite-plus/test";
import { renderError } from "../src/cli/error.ts";
import { addUsage, emptyUsage, header, usage } from "../src/cli/output.ts";
import { Runner } from "../src/runner/run.ts";
import { SandboxProviderError } from "../src/sandbox/errors.ts";

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

	it("renders typed provider failures without an Effect stack", () => {
		const output = renderError(
			new Runner.ProviderError({
				provider: "openrouter",
				model: "stealth/ox-alpha",
				reason: new Runner.ProviderAuthenticationError({
					authentication: "missing",
					message: "provider credentials are missing",
					isRetryable: false,
				}),
			}),
		);

		expect(output).toContain("error[authentication]: openrouter/stealth/ox-alpha: provider credentials are missing");
		expect(output).toContain("provider: openrouter");
		expect(output).toContain("hint: set OPENROUTER_API_KEY and retry");
		expect(output).not.toContain("Runner.ProviderError");
	});

	it("renders the sanitized sandbox provider failure", () => {
		const output = renderError(
			new SandboxProviderError({
				driver: "vercel",
				operation: "create",
				sanitized: {
					name: "APIError",
					message: "The project is not authorized to create a sandbox",
					code: "forbidden",
				},
			}),
		);

		expect(output).toContain("error: SandboxProviderError - The project is not authorized to create a sandbox");
		expect(output).toContain("driver: vercel");
		expect(output).toContain("operation: create");
		expect(output).toContain("code: forbidden");
		expect(output).toMatch(/traceback:\nSandboxProviderError(?:: )?\n/);
	});
});
