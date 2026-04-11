import { isDeepStrictEqual } from "node:util";
import { Agent } from "../../../src/agent/agent";
import { CodeMode } from "../../../src/agent/codemode/codemode";
import { createQuickJSWasiDriver } from "../../../src/agent/codemode/drivers/quickjs-wasi-driver";
import { Message } from "../../../src/message/message";
import type { CodeModeEvalScenario } from "./scenarios";

const LIVE_CODEMODE_MODEL = "claude-haiku-4-5-20251001";

function extractText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function extractJsonObject(text: string): Record<string, unknown> {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error(`Expected JSON object in assistant response.\nReceived:\n${text}`);
	}
	return JSON.parse(match[0]) as Record<string, unknown>;
}

function buildResponseShape(value: unknown): unknown {
	if (typeof value === "string") return "...";
	if (typeof value === "number") return 0;
	if (typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.map((item) => buildResponseShape(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nestedValue]) => [key, buildResponseShape(nestedValue)]),
		);
	}
	return null;
}

function getCompletedSandboxToolCalls(messages: Message.Message[]) {
	return messages.flatMap((message) => {
		if (message.role !== "assistant") return [];
		return message.parts.filter(
			(part): part is Message.ToolCallCompletedPart =>
				part.type === "toolCall" && part.name === "sandbox_execute_typescript" && part.status === "completed",
		);
	});
}

export interface CodeModeEvalReport<TExpected extends Record<string, unknown>> {
	scenarioID: string;
	scenarioName: string;
	sandboxCallCount: number;
	generatedCode: string;
	sandboxResult: TExpected;
	finalJson: TExpected;
	finalText: string;
	successfulSandboxCall: boolean;
	finalMatchesSandbox: boolean;
	finalMatchesExpected: boolean;
}

export async function runCodeModeEval<TExpected extends Record<string, unknown>>(
	scenario: CodeModeEvalScenario<TExpected>,
): Promise<CodeModeEvalReport<TExpected>> {
	const codeMode = await CodeMode.create({
		driver: createQuickJSWasiDriver(),
		tools: scenario.tools,
	});

	const responseShape = JSON.stringify(buildResponseShape(scenario.expected));
	const instance = await Agent.create({
		provider: "anthropic",
		model: LIVE_CODEMODE_MODEL,
		name: `codemode-eval-${scenario.id}`,
		getApiKey: async () => process.env.ANTHROPIC_API_KEY,
		initialState: {
			systemPrompt: [
				"Use sandbox_execute_typescript exactly once for this task.",
				...(scenario.systemInstructions ?? []),
				"After the tool completes, respond with exactly one JSON object and no markdown.",
				`JSON shape: ${responseShape}`,
				codeMode.systemPrompt,
			].join("\n\n"),
			tools: [codeMode.tool],
		},
	});

	await instance.prompt([
		{
			type: "text",
			text: scenario.prompt,
		},
	]);

	const sandboxCalls = getCompletedSandboxToolCalls(instance.state.messages);
	const sandboxCall = sandboxCalls.at(-1);

	if (!sandboxCall) {
		throw new Error(`Expected completed sandbox_execute_typescript call for scenario "${scenario.id}"`);
	}

	const generatedCode = (sandboxCall.arguments as { typescriptCode?: string }).typescriptCode;
	if (!generatedCode) {
		throw new Error(`Expected generated TypeScript for scenario "${scenario.id}"`);
	}

	const sandboxResult = (sandboxCall.result.details as CodeMode.SandboxExecutionOutput).result as TExpected;
	const finalMessage = instance.state.messages.at(-1);
	if (!finalMessage || finalMessage.role !== "assistant") {
		throw new Error(`Expected final assistant message for scenario "${scenario.id}"`);
	}

	const finalText = extractText(finalMessage).trim();
	const finalJson = extractJsonObject(finalText) as TExpected;

	return {
		scenarioID: scenario.id,
		scenarioName: scenario.name,
		sandboxCallCount: sandboxCalls.length,
		generatedCode,
		sandboxResult,
		finalJson,
		finalText,
		successfulSandboxCall: sandboxCall.result.isError === false,
		finalMatchesSandbox: isDeepStrictEqual(finalJson, sandboxResult),
		finalMatchesExpected: isDeepStrictEqual(finalJson, scenario.expected),
	};
}
