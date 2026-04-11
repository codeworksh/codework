import { Type } from "@sinclair/typebox";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Agent } from "../src/agent/agent";
import { CodeMode } from "../src/agent/codemode";

const PROMPT_SNAPSHOT_PATH = join(tmpdir(), "aikit-codemode-system-prompt.txt");

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

describe("CodeMode.generateTypeStubs", () => {
	it("renders TypeScript value shapes for mixed schema kinds", () => {
		const stubs = CodeMode.generateTypeStubs({
			external_loadLedger: {
				name: "external_loadLedger",
				description: "Load ledger entries for an account",
				inputSchema: Type.Object({
					accountId: Type.String(),
					limit: Type.Optional(Type.Number()),
					currency: Type.Union([Type.Literal("USD"), Type.Literal("EUR")]),
				}),
				outputSchema: Type.Object({
					entries: Type.Array(
						Type.Object({
							principalNanos: Type.String(),
							rateBps: Type.Number(),
							days: Type.Number(),
						}),
					),
					metadata: Type.Unknown(),
				}),
				execute: async () => undefined,
			},
			external_feeModel: {
				name: "external_feeModel",
				description: "Resolve fee schedule",
				inputSchema: Type.Unknown(),
				outputSchema: Type.Any(),
				execute: async () => undefined,
			},
			external_rollup: {
				name: "external_rollup",
				description: "Store aggregated metrics",
				inputSchema: Type.Record(Type.String(), Type.Number()),
				execute: async () => undefined,
			},
		});

		expect(stubs).toContain("type External_loadLedgerInput = {\n\taccountId: string;");
		expect(stubs).toContain("limit?: number;");
		expect(stubs).toContain('currency: "USD" | "EUR";');
		expect(stubs).toContain("type External_loadLedgerOutput = {\n\tentries: Array<{");
		expect(stubs).toContain("principalNanos: string;");
		expect(stubs).toContain("rateBps: number;");
		expect(stubs).toContain("metadata: unknown;");
		expect(stubs).toContain("/** Load ledger entries for an account */");
		expect(stubs).toContain(
			"declare function external_loadLedger(input: External_loadLedgerInput): Promise<External_loadLedgerOutput>;",
		);
		expect(stubs).toContain("type External_feeModelInput = unknown;");
		expect(stubs).toContain("type External_feeModelOutput = any;");
		expect(stubs).toContain("type External_rollupInput = Record<string, number>;");
		expect(stubs).toContain("declare function external_rollup(input: External_rollupInput): Promise<unknown>;");
		expect(stubs).not.toContain("properties:");
		expect(stubs).not.toContain("required:");
		expect(stubs).not.toContain("type: 'object'");
	});
});

describe("CodeMode.create", () => {
	it("builds a system prompt and returns the sandbox tool", async () => {
		let capturedCode = "";

		const codeMode = await CodeMode.create({
			driver: {
				async createContext(_config: CodeMode.DriverContextConfig) {
					const context: CodeMode.Context = {
						async execute<T = unknown>(code: string): Promise<CodeMode.ExecutionResult<T>> {
							capturedCode = code;
							return {
								success: true,
								value: { ok: true } as T,
								logs: ["mock log"],
							};
						},
						async dispose() {},
					};
					return context;
				},
			},
			tools: [
				Agent.defineTool({
					name: "loadLedger",
					label: "Load Ledger",
					description: "Load ledger entries for an account",
					parameters: Type.Object({
						accountId: Type.String(),
						limit: Type.Optional(Type.Number()),
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
								content: [{ type: "text" as const, text: "ok" }],
								details: {
									entries: [{ principalNanos: "1000", rateBps: 500, days: 30 }],
								},
								isError: false as const,
							},
						};
					},
				}),
				Agent.defineTool({
					name: "feeModel",
					label: "Fee Model",
					description: "Resolve fee schedule",
					parameters: Type.Unknown(),
					outputSchema: Type.Any(),
					async execute() {
						return {
							status: "completed" as const,
							result: {
								content: [{ type: "text" as const, text: "ok" }],
								details: { anything: true },
								isError: false as const,
							},
						};
					},
				}),
				Agent.defineTool({
					name: "rollup",
					label: "Rollup",
					description: "Store aggregated metrics",
					parameters: Type.Record(Type.String(), Type.Number()),
					async execute() {
						return {
							status: "completed" as const,
							result: {
								content: [{ type: "text" as const, text: "ok" }],
								isError: false as const,
							},
						};
					},
				}),
			],
		});

		expect(codeMode.systemPrompt).toContain("## Code Execution Tool");
		expect(codeMode.systemPrompt).toContain("sandbox_execute_typescript");
		expect(codeMode.systemPrompt).toContain("- `external_loadLedger(input)`: Load ledger entries for an account");
		expect(codeMode.systemPrompt).toContain("- `external_feeModel(input)`: Resolve fee schedule");
		expect(codeMode.systemPrompt).toContain("- `external_rollup(input)`: Store aggregated metrics");
		expect(codeMode.systemPrompt).toContain("type External_loadLedgerInput = {");
		expect(codeMode.systemPrompt).toContain("type External_loadLedgerOutput = {");
		expect(codeMode.systemPrompt).toContain("type External_feeModelInput = unknown;");
		expect(codeMode.systemPrompt).toContain("type External_feeModelOutput = any;");
		expect(codeMode.systemPrompt).toContain("type External_rollupInput = Record<string, number>;");
		expect(codeMode.systemPrompt).toContain(
			"declare function external_rollup(input: External_rollupInput): Promise<unknown>;",
		);
		expect(codeMode.tool.name).toBe("sandbox_execute_typescript");
		expect(codeMode.tool.outputSchema).toBe(CodeMode.SandboxExecutionOutputSchema);
		expect(codeMode.tool.errorSchema).toBe(CodeMode.SandboxExecutionErrorSchema);

		const result = await codeMode.tool.execute("call_1", {
			typescriptCode: `
				type Invoice = {
					subtotalCents: number;
					taxRate: number;
					discountRate: number;
				};

				const invoice: Invoice = {
					subtotalCents: 987_654_321,
					taxRate: 0.18,
					discountRate: 0.035,
				};

				const discountedSubtotal = Math.round(invoice.subtotalCents * (1 - invoice.discountRate));
				const totalCents = Math.round(discountedSubtotal * (1 + invoice.taxRate));

				return { discountedSubtotal, totalCents };
			`,
		});

		expect(result).toEqual({
			status: "completed",
			result: {
				content: [{ type: "text", text: "Sandbox execution completed" }],
				details: {
					result: { ok: true },
					logs: ["mock log"],
				},
				isError: false,
			},
		});
		expect(capturedCode).toContain("const invoice = {");
		expect(capturedCode).not.toContain("type Invoice");
		expect(capturedCode).not.toContain(": Invoice");

		await writeFile(PROMPT_SNAPSHOT_PATH, codeMode.systemPrompt, "utf8");
		const writtenPrompt = await readFile(PROMPT_SNAPSHOT_PATH, "utf8");

		expect(writtenPrompt).toBe(codeMode.systemPrompt);
	});

	it("returns a normal AgentTool error result when sandbox execution fails", async () => {
		const codeMode = await CodeMode.create({
			driver: {
				async createContext(_config: CodeMode.DriverContextConfig) {
					const context: CodeMode.Context = {
						async execute<T = unknown>(_code: string): Promise<CodeMode.ExecutionResult<T>> {
							return {
								success: false,
								error: {
									name: "SandboxError",
									message: "mock sandbox failure",
									line: 7,
								},
								logs: ["ERROR: mock sandbox failure"],
							};
						},
						async dispose() {},
					};
					return context;
				},
			},
			tools: [],
		});

		const result = await codeMode.tool.execute("call_1", {
			typescriptCode: "return 1;",
		});

		expect(result).toEqual({
			status: "error",
			result: {
				content: [{ type: "text", text: "mock sandbox failure" }],
				details: {
					name: "SandboxError",
					message: "mock sandbox failure",
					line: 7,
					logs: ["ERROR: mock sandbox failure"],
				},
				isError: true,
			},
		});
	});
});

describe("CodeMode QuickJS-WASI driver", () => {
	it("executes business logic with large-number calculations in the sandbox", async () => {
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

		const loadLedgerTool = Agent.defineTool({
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
			async execute(_callID, _params) {
				return {
					status: "completed" as const,
					result: {
						content: [{ type: "text" as const, text: "loaded" }],
						details: { entries: ledgerEntries },
						isError: false as const,
					},
				};
			},
		});

		const resolveFeeTool = Agent.defineTool({
			name: "resolveFeeModel",
			label: "Resolve Fee Model",
			description: "Resolve fee basis points for an account",
			parameters: Type.Object({
				accountId: Type.String(),
			}),
			outputSchema: Type.Object({
				feeBps: Type.Number(),
			}),
			async execute(_callID, _params) {
				return {
					status: "completed" as const,
					result: {
						content: [{ type: "text" as const, text: "resolved" }],
						details: { feeBps },
						isError: false as const,
					},
				};
			},
		});

		const codeMode = await CodeMode.create({
			driver: CodeMode.createQuickJSWasiDriver(),
			tools: [loadLedgerTool, resolveFeeTool],
		});

		const result = await codeMode.tool.execute("call_1", {
			typescriptCode: `
				type LedgerEntry = {
					principalNanos: string;
					rateBps: number;
					days: number;
				};

				const [{ entries }, { feeBps }] = await Promise.all([
					external_loadLedger({ accountId: "acct_123" }),
					external_resolveFeeModel({ accountId: "acct_123" }),
				]);

				const totals = entries.reduce(
					(acc, entry: LedgerEntry) => {
						const principal = BigInt(entry.principalNanos);
						const gross = (principal * BigInt(entry.rateBps) * BigInt(entry.days)) / 36500n;
						const fee = (gross * BigInt(feeBps)) / 10000n;

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

				console.log(String(totals.grossNanos), String(totals.feeNanos), String(totals.netNanos));
				return totals;
			`,
		});

		expect(result.status).toBe("completed");
		expect(result.result.details).toEqual({
			result: {
				grossNanos: expected.grossNanos,
				feeNanos: expected.feeNanos,
				netNanos: expected.netNanos,
			},
			logs: [`${expected.grossNanos} ${expected.feeNanos} ${expected.netNanos}`],
		});
	});

	it("transpiles TypeScript business logic before executing it in QuickJS-WASI", async () => {
		const codeMode = await CodeMode.create({
			driver: CodeMode.createQuickJSWasiDriver(),
			tools: [],
		});

		const result = await codeMode.tool.execute("call_1", {
			typescriptCode: `
				type ProfitModel = {
					revenue: number;
					cost: number;
					taxRate: number;
				};

				const model: ProfitModel = {
					revenue: 9_876_543.21,
					cost: 6_543_210.12,
					taxRate: 0.21,
				};

				return {
					grossProfit: Number((model.revenue - model.cost).toFixed(2)),
					netProfit: Number(((model.revenue - model.cost) * (1 - model.taxRate)).toFixed(2)),
				};
			`,
		});

		expect(result).toEqual({
			status: "completed",
			result: {
				content: [{ type: "text", text: "Sandbox execution completed" }],
				details: {
					result: {
						grossProfit: 3333333.09,
						netProfit: 2633333.14,
					},
				},
				isError: false,
			},
		});
	});

	it("surfaces tool validation failures back through sandbox execution", async () => {
		const strictTool = Agent.defineTool({
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
			async execute(_callID, _params) {
				return {
					status: "completed" as const,
					result: {
						content: [{ type: "text" as const, text: "loaded" }],
						details: { entries: [] },
						isError: false as const,
					},
				};
			},
		});

		const codeMode = await CodeMode.create({
			driver: CodeMode.createQuickJSWasiDriver(),
			tools: [strictTool],
		});

		const result = await codeMode.tool.execute("call_1", {
			typescriptCode: `
				await external_loadLedger({ ledgerId: "missing-required-account-id" });
				return { ok: true };
			`,
		});

		expect(result.status).toBe("error");
		expect(result.result.details).toMatchObject({
			message: expect.stringContaining('Validation Failed For Tool "loadLedger" input'),
		});
	});
});
