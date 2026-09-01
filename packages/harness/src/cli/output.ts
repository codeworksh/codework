import type { Message } from "@codeworksh/aikit";

export interface UsageSummary {
	readonly turns: number;
	readonly provider?: string;
	readonly model?: string;
	readonly input: number;
	readonly output: number;
	readonly reasoning: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
}

export const emptyUsage: UsageSummary = {
	turns: 0,
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

export const addUsage = (summary: UsageSummary, message: Message.AssistantMessage): UsageSummary => ({
	turns: summary.turns + 1,
	provider: message.provider.id,
	model: message.responseModel ?? message.model,
	input: summary.input + message.usage.input,
	output: summary.output + message.usage.output,
	reasoning: summary.reasoning + (message.usage.reasoning ?? 0),
	cacheRead: summary.cacheRead + message.usage.cacheRead,
	cacheWrite: summary.cacheWrite + message.usage.cacheWrite,
	totalTokens: summary.totalTokens + message.usage.totalTokens,
	cost: summary.cost + message.usage.cost.total,
});

const number = new Intl.NumberFormat("en-US");
const row = (label: string, value: string) => `${label.padEnd(9)}${value}\n`;

const formatCost = (cost: number): string => `$${cost.toFixed(cost > 0 && cost < 0.01 ? 6 : 4)}`;

export const divider = (label: string, columns = 72): string => {
	const width = Math.min(100, Math.max(32, columns));
	const start = `── ${label} `;
	return `${start}${"─".repeat(Math.max(2, width - start.length))}\n`;
};

export const header = (input: {
	readonly sessionId: string;
	readonly sandbox: string;
	readonly directory: string;
	readonly columns?: number;
}): string =>
	`${row("session", input.sessionId)}${row("sandbox", `${input.sandbox} · ${input.directory}`)}\n${divider(
		"response",
		input.columns,
	)}`;

export const usage = (summary: UsageSummary, columns?: number): string => {
	const turns = `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}`;
	const model =
		summary.provider === undefined || summary.model === undefined
			? "unknown"
			: `${summary.provider}/${summary.model}`;
	const reasoning = summary.reasoning === 0 ? "" : ` · ${number.format(summary.reasoning)} reasoning`;
	return `${divider("usage", columns)}${row("model", model)}${row(
		"tokens",
		`${number.format(summary.input)} input · ${number.format(summary.output)} output${reasoning} · ${number.format(
			summary.totalTokens,
		)} total`,
	)}${row("cache", `${number.format(summary.cacheRead)} read · ${number.format(summary.cacheWrite)} write`)}${row(
		"cost",
		`${formatCost(summary.cost)} · ${turns}`,
	)}`;
};
