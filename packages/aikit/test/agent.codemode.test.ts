import "./utils/env";
import { beforeEach, afterEach, describe, expect, it } from "vite-plus/test";
import { Type } from "@sinclair/typebox";
import { Agent } from "../src/agent/agent";
import { CodeMode } from "../src/agent/codemode";
import { Message } from "../src/message/message";
import { ModelCatalog } from "../src/model/catalog";
import { Model } from "../src/model/model";
import { ROOT_MODELS_PATH } from "./utils/paths";

type LedgerEntry = {
	principalNanos: string;
	rateBps: number;
	days: number;
};

function calculateLedgerTotals(entries: LedgerEntry[], feeBps: number) {
	return entries.reduce(
		(acc, entry) => {
			const principal = BigInt(entry.principalNanos);
			const gross = (principal * BigInt(entry.rateBps) * BigInt(entry.days)) / 36500n;
			const fee = (gross * BigInt(feeBps)) / 10_000n;

			acc.grossNanos += gross;
			acc.feeNanos += fee;
			acc.netNanos += gross - fee;
			return acc;
		},
		{
			grossNanos: 0n,
			feeNanos: 0n,
			netNanos: 0n,
		},
	);
}

function extractText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function extractJsonObject(text: string): Record<string, string> {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error(`Expected JSON object in assistant response.\nReceived:\n${text}`);
	}
	return JSON.parse(match[0]) as Record<string, string>;
}

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfAnthropic("Agent CodeMode integration", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("runs sandbox_execute_typescript through a live Anthropic agent and returns the computed ledger totals", async () => {
		const ledgerEntries: LedgerEntry[] = [
			{
				principalNanos: "987654321012345678",
				rateBps: 735,
				days: 31,
			},
			{
				principalNanos: "123456789009876543",
				rateBps: 512,
				days: 17,
			},
		];
		const feeBps = 145;
		const expected = calculateLedgerTotals(ledgerEntries, feeBps);

		const codeMode = await CodeMode.create({
			driver: CodeMode.createQuickJSWasiDriver(),
			tools: [
				Agent.defineTool({
					name: "loadLedger",
					label: "Load Ledger",
					description: "Load ledger entries for an account",
					parameters: Type.Object({
						accountId: Type.String(),
					}),
					outputSchema: Type.Object({
						entries: Type.Array(
							Type.Object({
								principalNanos: Type.String(),
								rateBps: Type.Number(),
								days: Type.Number(),
							}),
						),
					}),
					async execute() {
						return {
							status: "completed" as const,
							result: {
								content: [{ type: "text" as const, text: "loaded" }],
								details: { entries: ledgerEntries },
								isError: false as const,
							},
						};
					},
				}),
				Agent.defineTool({
					name: "resolveFeeModel",
					label: "Resolve Fee Model",
					description: "Resolve fee basis points for an account",
					parameters: Type.Object({
						accountId: Type.String(),
					}),
					outputSchema: Type.Object({
						feeBps: Type.Number(),
					}),
					async execute() {
						return {
							status: "completed" as const,
							result: {
								content: [{ type: "text" as const, text: "resolved" }],
								details: { feeBps },
								isError: false as const,
							},
						};
					},
				}),
			],
		});

		const instance = await Agent.create({
			provider: "anthropic",
			model: "claude-haiku-4-5-20251001",
			name: "live-codemode-agent",
			getApiKey: async () => process.env.ANTHROPIC_API_KEY,
			initialState: {
				systemPrompt: [
					"Use sandbox_execute_typescript exactly once for this task.",
					"Do not do the math mentally.",
					"After the tool completes, respond with exactly one JSON object and no markdown.",
					'JSON shape: {"grossNanos":"...","feeNanos":"...","netNanos":"..." }',
					codeMode.systemPrompt,
				].join("\n\n"),
				tools: [codeMode.tool],
			},
		});

		await instance.prompt([
			{
				type: "text",
				text: [
					'Compute ledger totals for account "acct_123".',
					"Use the sandbox and inside it call external_loadLedger and external_resolveFeeModel.",
					"Use this exact integer arithmetic formula and do not change the denominators:",
					"grossNanos = (principalNanos * rateBps * days) / 36500",
					"feeNanos = (grossNanos * feeBps) / 10000",
					"netNanos = grossNanos - feeNanos",
					"Return grossNanos, feeNanos, and netNanos as decimal strings.",
				].join(" "),
			},
		]);

		const toolUseMessage = instance.state.messages.find(
			(message): message is Message.AssistantMessage =>
				message.role === "assistant" &&
				message.stopReason === "toolUse" &&
				message.parts.some(
					(part) =>
						part.type === "toolCall" && part.name === "sandbox_execute_typescript" && part.status === "completed",
				),
		);
		expect(toolUseMessage).toBeDefined();

		const sandboxToolCall = toolUseMessage?.parts.find(
			(part): part is Message.ToolCallCompletedPart =>
				part.type === "toolCall" && part.name === "sandbox_execute_typescript" && part.status === "completed",
		);
		expect(sandboxToolCall).toBeDefined();
		if (!sandboxToolCall) {
			throw new Error("Expected completed sandbox_execute_typescript tool call");
		}
		expect(sandboxToolCall.arguments).toHaveProperty("typescriptCode");
		const { typescriptCode } = sandboxToolCall.arguments as { typescriptCode?: string };
		expect(typescriptCode).toContain("external_loadLedger");
		expect(typescriptCode).toContain("external_resolveFeeModel");
		expect(typescriptCode).toContain("/ 36500");
		expect(typescriptCode).toContain("/ 10000");
		const sandboxResult = sandboxToolCall.result.details as {
			result?: Record<string, string>;
		};
		expect(sandboxResult.result).toBeDefined();

		const finalMessage = instance.state.messages.at(-1);
		expect(finalMessage?.role).toBe("assistant");

		const finalText = extractText(finalMessage as Message.AssistantMessage).trim();
		const parsed = extractJsonObject(finalText);

		expect(parsed).toEqual(sandboxResult.result);
		expect(parsed.grossNanos).toBeDefined();
		expect(parsed.feeNanos).toBeDefined();
		expect(parsed.netNanos).toBeDefined();
		expect(parsed.grossNanos).toBe(expected.grossNanos.toString());
	}, 60_000);
});
