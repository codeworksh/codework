import { Type } from "@sinclair/typebox";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Agent } from "../src/agent/agent";
import { CodeMode } from "../src/agent/codemode";

const PROMPT_SNAPSHOT_PATH = join(tmpdir(), "aikit-codemode-system-prompt.txt");

describe("CodeMode.generateTypeStubs", () => {
	it("renders TypeScript value shapes for mixed schema kinds", () => {
		const stubs = CodeMode.generateTypeStubs({
			external_search: {
				name: "external_search",
				description: "Search indexed documents",
				inputSchema: Type.Object({
					query: Type.String(),
					limit: Type.Optional(Type.Number()),
					tags: Type.Array(Type.Union([Type.Literal("recent"), Type.Literal("archived")])),
				}),
				outputSchema: Type.Object({
					hits: Type.Number(),
					source: Type.Union([Type.Literal("cache"), Type.Literal("network")]),
					metadata: Type.Unknown(),
				}),
				execute: async () => undefined,
			},
			external_loose: {
				name: "external_loose",
				description: "Pass-through helper",
				inputSchema: Type.Unknown(),
				outputSchema: Type.Any(),
				execute: async () => undefined,
			},
			external_metrics: {
				name: "external_metrics",
				description: "Collect metrics",
				inputSchema: Type.Record(Type.String(), Type.Number()),
				execute: async () => undefined,
			},
		});

		expect(stubs).toContain("type External_searchInput = {\n\tquery: string;");
		expect(stubs).toContain("limit?: number;");
		expect(stubs).toContain('tags: Array<"recent" | "archived">;');
		expect(stubs).toContain("type External_searchOutput = {\n\thits: number;");
		expect(stubs).toContain('source: "cache" | "network";');
		expect(stubs).toContain("metadata: unknown;");
		expect(stubs).toContain("/** Search indexed documents */");
		expect(stubs).toContain(
			"declare function external_search(input: External_searchInput): Promise<External_searchOutput>;",
		);
		expect(stubs).toContain("type External_looseInput = unknown;");
		expect(stubs).toContain("type External_looseOutput = any;");
		expect(stubs).toContain("type External_metricsInput = Record<string, number>;");
		expect(stubs).toContain("declare function external_metrics(input: External_metricsInput): Promise<unknown>;");
		expect(stubs).not.toContain("properties:");
		expect(stubs).not.toContain("required:");
		expect(stubs).not.toContain("type: 'object'");
	});
});

describe("CodeMode.create", () => {
	it("builds a system prompt from agent tools and writes it to a temp file", async () => {
		const searchTool = Agent.defineTool({
			name: "search",
			label: "Search",
			description: "Search indexed documents",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Number()),
			}),
			outputSchema: Type.Object({
				hits: Type.Number(),
				source: Type.Union([Type.Literal("cache"), Type.Literal("network")]),
			}),
			async execute() {
				return {
					status: "completed" as const,
					result: {
						content: [{ type: "text" as const, text: "ok" }],
						details: { hits: 1, source: "cache" as const },
						isError: false as const,
					},
				};
			},
		});

		const looseTool = Agent.defineTool({
			name: "loose",
			label: "Loose",
			description: "Pass-through helper",
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
		});

		const metricsTool = Agent.defineTool({
			name: "metrics",
			label: "Metrics",
			description: "Collect metrics",
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
		});

		const codeMode = await CodeMode.create({
			driver: {},
			tools: [searchTool, looseTool, metricsTool],
		});

		expect(codeMode.systemPrompt).toContain("## Code Execution Tool");
		expect(codeMode.systemPrompt).toContain("- `external_search(input)`: Search indexed documents");
		expect(codeMode.systemPrompt).toContain("- `external_loose(input)`: Pass-through helper");
		expect(codeMode.systemPrompt).toContain("- `external_metrics(input)`: Collect metrics");
		expect(codeMode.systemPrompt).toContain("type External_searchInput = {");
		expect(codeMode.systemPrompt).toContain("type External_searchOutput = {");
		expect(codeMode.systemPrompt).toContain("type External_looseInput = unknown;");
		expect(codeMode.systemPrompt).toContain("type External_looseOutput = any;");
		expect(codeMode.systemPrompt).toContain("type External_metricsInput = Record<string, number>;");
		expect(codeMode.systemPrompt).toContain(
			"declare function external_metrics(input: External_metricsInput): Promise<unknown>;",
		);

		await writeFile(PROMPT_SNAPSHOT_PATH, codeMode.systemPrompt, "utf8");
		const writtenPrompt = await readFile(PROMPT_SNAPSHOT_PATH, "utf8");

		expect(writtenPrompt).toBe(codeMode.systemPrompt);
	});
});
