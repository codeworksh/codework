import { Agent, CodeMode, Message } from "@codeworksh/aikit";
import { createQuickJSWasiDriver } from "@codeworksh/aikit/agent/codemode/drivers/drivers";
import Type, { type Static } from "typebox";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const defaultPrompt = "How much did I spend on Food in the last 90 days?";
const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
} as const;

const FinanceRowSchema = Type.Object({
	no: Type.Integer({ minimum: 1 }),
	debits: Type.Union([Type.Number(), Type.Null()]),
	credits: Type.Union([Type.Number(), Type.Null()]),
	category: Type.String(),
	name: Type.String(),
	date: Type.String(),
});

const ReadStatementCsvParameters = Type.Object({}, { additionalProperties: false });
const ReadStatementCsvOutput = Type.Object({
	sourceFile: Type.String(),
	totalRows: Type.Integer({ minimum: 0 }),
	rows: Type.Array(FinanceRowSchema),
});

type FinanceRow = Static<typeof FinanceRowSchema>;
type ReadStatementCsvParams = Static<typeof ReadStatementCsvParameters>;
type AssistantPart = Message.AssistantMessage["parts"][number];
type Usage = Message.Usage;
type AgentEvent = { type?: string };
type MessagePartUpdateEvent = {
	type: "message.part.update";
	message: Message.AssistantMessage;
	partIndex: number;
	part: AssistantPart;
	source: "llm" | "tool";
};
type MessagePartEndEvent = {
	type: "message.part.end";
	message: Message.AssistantMessage;
	partIndex: number;
	part: AssistantPart;
};
type ToolExecutionStartEvent = {
	type: "tool.execution.start";
	callID: string;
	name: string;
};
type ToolExecutionEndEvent = {
	type: "tool.execution.end";
	callID: string;
	name: string;
	status: "completed" | "error";
};
type TurnEndEvent = {
	type: "turn.end";
	message: Message.AssistantMessage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMessagePartUpdateEvent(event: AgentEvent): event is MessagePartUpdateEvent {
	return (
		event.type === "message.part.update" &&
		isRecord(event) &&
		"message" in event &&
		"part" in event &&
		"partIndex" in event &&
		"source" in event
	);
}

function isMessagePartEndEvent(event: AgentEvent): event is MessagePartEndEvent {
	return (
		event.type === "message.part.end" &&
		isRecord(event) &&
		"message" in event &&
		"part" in event &&
		"partIndex" in event
	);
}

function isToolExecutionStartEvent(event: AgentEvent): event is ToolExecutionStartEvent {
	return event.type === "tool.execution.start" && isRecord(event) && "callID" in event && "name" in event;
}

function isToolExecutionEndEvent(event: AgentEvent): event is ToolExecutionEndEvent {
	return (
		event.type === "tool.execution.end" &&
		isRecord(event) &&
		"callID" in event &&
		"name" in event &&
		"status" in event
	);
}

function isTurnEndEvent(event: AgentEvent): event is TurnEndEvent {
	return event.type === "turn.end" && isRecord(event) && "message" in event;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

function getFinalAssistantText(agent: Agent.Instance): string {
	const finalMessage = getLatestAssistantMessage(agent);

	if (!finalMessage) {
		return "No assistant response was produced.";
	}

	const textParts = finalMessage.parts
		.filter((part: Message.AssistantMessage["parts"][number]): part is Message.TextContent => part.type === "text")
		.map((part: Message.TextContent) => part.text.trim())
		.filter(Boolean);

	return textParts.join("\n\n") || "The assistant finished without a text response.";
}

function getLatestAssistantMessage(agent: Agent.Instance): Message.AssistantMessage | undefined {
	return getAssistantMessages(agent).at(-1);
}

function getAssistantMessages(agent: Agent.Instance): Message.AssistantMessage[] {
	return agent.state.messages.filter(
		(message: Message.Message): message is Message.AssistantMessage => message.role === "assistant",
	);
}

function addUsageTotals(target: Usage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
}

function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function printUsage(label: string, usage: Usage): void {
	console.log(`${colors.dim}${label}${colors.reset}`);
	console.log(
		`${colors.dim}  input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} total=${usage.totalTokens}${colors.reset}`,
	);
	console.log(`${colors.dim}  costTotal=${usage.cost.total.toFixed(6)}${colors.reset}\n`);
}

function printToolCallEvents(events: string[]): void {
	console.log(`${colors.dim}Tool call events:${colors.reset}`);

	if (events.length === 0) {
		console.log(`${colors.dim}  none${colors.reset}\n`);
		return;
	}

	for (const event of events) {
		console.log(`${colors.dim}  ${event}${colors.reset}`);
	}

	console.log("");
}

function last<T>(items: T[]): T | undefined {
	return items.at(-1);
}

function readTextPreview(content: unknown[] | undefined): string | undefined {
	const preview = last(content ?? []);
	return isRecord(preview) && preview.type === "text" && typeof preview.text === "string" ? preview.text : undefined;
}

function readTextContent(content: unknown[] | undefined): string | undefined {
	const text = (content ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");

	return text.length > 0 ? text : undefined;
}

function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];

		if (char === '"') {
			if (inQuotes && next === '"') {
				current += '"';
				index += 1;
				continue;
			}

			inQuotes = !inQuotes;
			continue;
		}

		if (char === "," && !inQuotes) {
			cells.push(current);
			current = "";
			continue;
		}

		current += char;
	}

	cells.push(current);
	return cells.map((cell) => cell.trim());
}

async function resolveStatementPath(): Promise<string> {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		process.env.STATEMENT_CSV_PATH,
		resolve(process.cwd(), "src/data/statement.csv"),
		resolve(currentDir, "data/statement.csv"),
		resolve(currentDir, "../src/data/statement.csv"),
	].filter((value): value is string => typeof value === "string" && value.length > 0);

	for (const candidate of candidates) {
		try {
			const absolutePath = resolve(candidate);
			await access(absolutePath);
			return absolutePath;
		} catch {}
	}

	throw new Error(
		"Could not resolve statement.csv. Set STATEMENT_CSV_PATH or place the file at src/data/statement.csv.",
	);
}

function createStatementTool(statementPath: string) {
	async function getRows(): Promise<FinanceRow[]> {
		const rawCsv = await readFile(statementPath, "utf8");
		const lines = rawCsv
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);

		if (lines.length < 2) {
			throw new Error(`Statement CSV is empty: ${statementPath}`);
		}

		const expectedHeaders = ["No", "Debits", "Credits", "Category", "Name", "Date"];
		const headers = parseCsvLine(lines[0] ?? "");
		if (headers.join(",") !== expectedHeaders.join(",")) {
			throw new Error(`Unexpected CSV headers in ${statementPath}. Expected: ${expectedHeaders.join(", ")}`);
		}

		return lines.slice(1).map((line, rowIndex) => {
			const values = parseCsvLine(line);
			const lineNumber = rowIndex + 2;

			if (values.length !== expectedHeaders.length) {
				throw new Error(`Expected ${expectedHeaders.length} columns on CSV line ${lineNumber}`);
			}

			const [no, debits, credits, category, name, date] = values;
			const rowNumber = Number(no);
			if (!Number.isInteger(rowNumber)) {
				throw new Error(`Invalid row number "${no}" on CSV line ${lineNumber}`);
			}

			const parseAmount = (value: string, columnName: string): number | null => {
				if (value === "" || value.toLowerCase() === "null") {
					return null;
				}

				const amount = Number(value);
				if (Number.isNaN(amount)) {
					throw new Error(`Invalid ${columnName} amount "${value}" on CSV line ${lineNumber}`);
				}

				return amount;
			};

			return {
				no: rowNumber,
				debits: parseAmount(debits ?? "", "Debits"),
				credits: parseAmount(credits ?? "", "Credits"),
				category: category ?? "",
				name: name ?? "",
				date: date ?? "",
			};
		});
	}

	return Agent.defineTool({
		name: "readStatementCsv",
		label: "Read Statement CSV",
		description:
			"Load parsed bank statement rows from the local CSV file. Debits are money out, credits are money in, and missing values are null.",
		parameters: ReadStatementCsvParameters,
		outputSchema: ReadStatementCsvOutput,
		async execute(
			_callID: string,
			_params: ReadStatementCsvParams,
			_signal?: AbortSignal,
			onUpdate?: Agent.ToolUpdateCallback,
		) {
			await onUpdate?.({
				status: "running",
				partial: {
					content: [{ type: "text", text: `Reading ${statementPath}` }],
				},
			});

			const rows = await getRows();

			return {
				status: "completed" as const,
				result: {
					content: [{ type: "text" as const, text: `Loaded ${rows.length} statement rows.` }],
					details: {
						sourceFile: statementPath,
						totalRows: rows.length,
						rows,
					},
					isError: false as const,
				},
			};
		},
	});
}

async function createAgent() {
	requireEnv("ANTHROPIC_API_KEY");
	const statementPath = await resolveStatementPath();
	const statementTool = createStatementTool(statementPath);
	const codeMode = await CodeMode.create({
		driver: createQuickJSWasiDriver(),
		tools: [statementTool],
	});

	const model = "claude-haiku-4-5-20251001";

	const agent = await Agent.create({
		name: "codemode-finance-csv-agent",
		provider: "anthropic",
		model,
		getApiKey: async () => process.env.ANTHROPIC_API_KEY,
		initialState: {
			tools: [codeMode.tool],
		},
	});

	agent.setSystemPrompt(
		[
			"You are a financial analyst working over a local CSV bank statement.",
			"Ground every analytical answer in the statement data. Do not guess.",
			"When answering, keep the response concise and include the key figures you computed.",
			`The loaded statement from ${statementPath}.`,
			"",
			codeMode.systemPrompt,
		].join("\n"),
	);

	return {
		agent,
		statementPath,
	};
}

function printBanner(statementPath: string): void {
	console.log(
		`${colors.cyan}${colors.bold}==============================================================\n` +
			`aikit CodeMode Finance CSV Agent\n` +
			`Analyze statement.csv with generated TypeScript\n` +
			`==============================================================${colors.reset}\n`,
	);
	console.log(`${colors.dim}Statement: ${statementPath}${colors.reset}`);
	console.log(`${colors.dim}Type a prompt and press Enter. Type 'exit' or 'quit' to stop.${colors.reset}`);
	console.log(`${colors.dim}Try: ${defaultPrompt}${colors.reset}\n`);
}

function question(rl: readline.Interface, prompt: string): Promise<string | null> {
	return new Promise((resolve) => {
		const onClose = () => resolve(null);
		rl.once("close", onClose);
		rl.question(prompt, (answer) => {
			rl.off("close", onClose);
			resolve(answer);
		});
	});
}

function printHelp(): void {
	console.log(`${colors.dim}Commands:${colors.reset}`);
	console.log(`${colors.dim}  /help  Show commands${colors.reset}`);
	console.log(`${colors.dim}  /reset Clear agent message history${colors.reset}`);
	console.log(`${colors.dim}  /exit  Quit the shell${colors.reset}\n`);
}

function createEventRenderer() {
	const textLengths = new Map<string, number>();
	let printedAssistantHeader = false;
	let printedBody = false;

	function ensureAssistantHeader(): void {
		if (printedAssistantHeader) {
			return;
		}

		printedAssistantHeader = true;
		process.stdout.write(`\n${colors.blue}${colors.bold}Agent:${colors.reset} `);
	}

	function writeToolLine(text: string): void {
		ensureAssistantHeader();
		if (printedBody) {
			process.stdout.write("\n");
		}
		process.stdout.write(`${colors.dim}${text}${colors.reset}\n`);
		printedBody = false;
	}

	return {
		handleEvent(event: AgentEvent): void {
			if (isMessagePartUpdateEvent(event)) {
				if (event.message.role !== "assistant") {
					return;
				}

				if (event.source === "llm" && event.part.type === "text") {
					ensureAssistantHeader();
					const key = `${event.message.messageId}:${event.partIndex}`;
					const previousLength = textLengths.get(key) ?? 0;
					const nextText = event.part.text.slice(previousLength);
					if (nextText) {
						process.stdout.write(nextText);
						printedBody = true;
						textLengths.set(key, event.part.text.length);
					}
					return;
				}

				if (event.source === "tool" && event.part.type === "toolCall" && event.part.status === "running") {
					const preview = readTextPreview(event.part.partial?.content);
					if (preview) {
						writeToolLine(`-> ${event.part.name}: ${preview}`);
					}
				}

				return;
			}

			if (isMessagePartEndEvent(event)) {
				if (event.message.role !== "assistant") {
					return;
				}

				if (event.part.type === "toolCall" && event.part.status === "pending") {
					writeToolLine(`-> planning tool call: ${event.part.name}`);
					return;
				}

				if (event.part.type === "toolCall" && event.part.status === "error") {
					const errorText = readTextContent(event.part.result.content);
					if (errorText) {
						writeToolLine(`-> ${event.part.name} error details:\n${errorText}`);
					}
				}

				return;
			}

			if (isToolExecutionStartEvent(event)) {
				writeToolLine(`-> running ${event.name}...`);
				return;
			}

			if (isToolExecutionEndEvent(event)) {
				const suffix = event.status === "completed" ? "done" : "error";
				writeToolLine(`-> ${event.name}: ${suffix}`);
				return;
			}

			if (isTurnEndEvent(event)) {
				if (event.message.role === "assistant" && event.message.stopReason === "toolUse") {
					writeToolLine("-> model requested tool execution");
				}
			}
		},
		finish(agent: Agent.Instance): void {
			if (!printedAssistantHeader) {
				console.log(`\n${colors.blue}${colors.bold}Agent:${colors.reset} ${getFinalAssistantText(agent)}\n`);
				return;
			}

			process.stdout.write("\n\n");
		},
	};
}

async function runShell(agent: Agent.Instance, statementPath: string): Promise<void> {
	const sessionUsage = createEmptyUsage();
	const toolCallEvents: string[] = [];
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	rl.on("SIGINT", () => {
		console.log(`\n${colors.dim}Interrupted. Type 'exit' to quit.${colors.reset}`);
		rl.prompt();
	});

	printBanner(statementPath);
	printHelp();

	while (true) {
		const answer = await question(rl, `${colors.green}You:${colors.reset} `);
		if (answer === null) {
			return;
		}

		const input = answer.trim();
		if (!input) {
			continue;
		}

		if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit" || input.toLowerCase() === "/exit") {
			printToolCallEvents(toolCallEvents);
			printUsage("Session token usage", sessionUsage);
			console.log(`\n${colors.dim}Goodbye.${colors.reset}`);
			rl.close();
			return;
		}

		if (input === "/help") {
			printHelp();
			continue;
		}

		if (input === "/reset") {
			agent.reset();
			console.log(`${colors.magenta}State cleared.${colors.reset}\n`);
			continue;
		}

		const renderer = createEventRenderer();
		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			renderer.handleEvent(event);

			if (isToolExecutionStartEvent(event)) {
				toolCallEvents.push(`started ${event.name} (${event.callID})`);
				return;
			}

			if (isToolExecutionEndEvent(event)) {
				toolCallEvents.push(`end ${event.name} (${event.callID}) status=${event.status}`);
			}
		});

		try {
			const assistantCountBeforePrompt = getAssistantMessages(agent).length;
			await agent.prompt([{ type: "text", text: input }]);
			renderer.finish(agent);

			const turnUsage = createEmptyUsage();
			const assistantMessages = getAssistantMessages(agent).slice(assistantCountBeforePrompt);
			for (const message of assistantMessages) {
				addUsageTotals(turnUsage, message.usage);
			}

			if (assistantMessages.length > 0) {
				addUsageTotals(sessionUsage, turnUsage);
				printUsage("Turn token usage", turnUsage);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`\n${colors.yellow}Error: ${message}${colors.reset}\n`);
		} finally {
			unsubscribe();
		}
	}
}

async function main(): Promise<void> {
	const { agent, statementPath } = await createAgent();
	await runShell(agent, statementPath);
}

await main();
