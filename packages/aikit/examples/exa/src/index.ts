import { Agent, Message, llm } from "@codeworksh/aikit";
import { type Static, Type } from "@sinclair/typebox";
import { Exa } from "exa-js";
import process from "node:process";
import * as readline from "node:readline";

const defaultPrompt = "Find 5 AI companies that raised seed and series A and explain what they do.";
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

const categorySchema = Type.Union([Type.Literal("company"), Type.Literal("people")]);
const searchTypeSchema = Type.Union([
	Type.Literal("fast"),
	Type.Literal("auto"),
	Type.Literal("deep"),
	Type.Literal("deep-reasoning"),
]);
const exaSearchParameters = Type.Object({
	query: Type.String({ minLength: 3 }),
	category: Type.Optional(categorySchema),
	type: Type.Optional(searchTypeSchema),
	numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
	includeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	excludeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

type ExaSearchParams = Static<typeof exaSearchParameters>;
type AssistantPart = Message.AssistantMessage["parts"][number];
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
	const assistantMessages = agent.state.messages.filter(
		(message: Message.Message): message is Message.AssistantMessage => message.role === "assistant",
	);
	const finalMessage = assistantMessages.at(-1);

	if (!finalMessage || finalMessage.role !== "assistant") {
		return "No assistant response was produced.";
	}

	const textParts = finalMessage.parts
		.filter((part: Message.AssistantMessage["parts"][number]): part is Message.TextContent => part.type === "text")
		.map((part: Message.TextContent) => part.text.trim())
		.filter(Boolean);

	return textParts.join("\n\n") || "The assistant finished without a text response.";
}

function last<T>(items: T[]): T | undefined {
	return items.at(-1);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function readTextPreview(content: unknown[] | undefined): string | undefined {
	const preview = last(content ?? []);
	return isRecord(preview) && preview.type === "text" && typeof preview.text === "string" ? preview.text : undefined;
}

function formatResult(result: Record<string, unknown>, index: number): string {
	const title = readStringField(result, "title") ?? "Untitled";
	const url = readStringField(result, "url") ?? "No URL";
	const summary = readStringField(result, "summary") ?? readStringField(result, "text");
	const highlights = readStringArrayField(result, "highlights");
	const publishedDate = readStringField(result, "publishedDate");

	const lines = [`${index + 1}. ${title}`, `URL: ${url}`];

	if (publishedDate) {
		lines.push(`Published: ${publishedDate}`);
	}

	if (highlights.length > 0) {
		lines.push(`Highlights: ${highlights.join(" ")}`);
	} else if (summary) {
		lines.push(`Summary: ${summary}`);
	}

	return lines.join("\n");
}

const exaSearchTool = Agent.defineTool<typeof exaSearchParameters>({
	name: "exa_search",
	label: "Exa Search",
	description:
		"Search Exa for people or companies relevant doing technical recruitment. Use category=company for company discovery and category=people for hiring teams.",
	parameters: exaSearchParameters,
	async execute(_callID: string, params: ExaSearchParams, _signal?: AbortSignal, onUpdate?: Agent.ToolUpdateCallback) {
		await onUpdate?.({
			status: "running",
			partial: {
				content: [
					{
						type: "text",
						text: `Searching Exa for ${params.category ?? "general"} results: ${params.query}`,
					},
				],
			},
		});

		try {
			const exa = new Exa(requireEnv("EXA_API_KEY"));
			const response = await exa.search(params.query, {
				category: params.category,
				type: params.type ?? "auto",
				numResults: params.numResults ?? 5,
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
			});

			const results = response.results.map((result: Record<string, unknown>, index: number) =>
				formatResult(result as Record<string, unknown>, index),
			);
			const content =
				results.length > 0 ? results.join("\n\n") : `No Exa results returned for query: ${params.query}`;

			return {
				status: "completed" as const,
				result: {
					content: [{ type: "text" as const, text: content }],
					isError: false,
					details: response.results,
				},
			};
		} catch (error) {
			return {
				status: "error" as const,
				result: {
					content: [
						{
							type: "text" as const,
							text: error instanceof Error ? error.message : String(error),
						},
					],
					isError: true,
					details: error,
				},
			};
		}
	},
});

async function createAgent(): Promise<Agent.Instance> {
	requireEnv("OPENAI_API_KEY");
	requireEnv("EXA_API_KEY");

	const model = await llm("openai", "gpt-5-nano", { protocol: "openai-completions" });
	if (!model)
		throw new Agent.ModelNotFoundErr({
			message: "model not found or not configured yet",
			provider: "openai",
			model: "gpt-5-nano",
		});
	console.log(model);
	const agent = await Agent.create({
		name: "exa-sales-agent",
		model,
		getApiKey: async () => process.env.OPENAI_API_KEY,
		initialState: {
			tools: [exaSearchTool],
		},
	});

	agent.setSystemPrompt(
		`
You are a concise technical recruitment agent. Helping developers look for jobs.

Use the exa_search tool whenever you need fresh company or people discovery.
Prefer company search for account targeting and people search for individual prospecting.
Return practical findings for hiring outreach and include the URLs you used.
`.trim(),
	);

	return agent;
}

function printBanner(): void {
	console.log(
		`${colors.cyan}${colors.bold}╔══════════════════════════════════════════════════════════════╗
║                    aikit Exa Recruitment Agent              ║
║           Interactive company and people research           ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}
`,
	);
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
						writeToolLine(`↳ ${event.part.name}: ${preview}`);
					}
				}

				return;
			}

			if (isMessagePartEndEvent(event)) {
				if (event.message.role !== "assistant") {
					return;
				}

				if (event.part.type === "toolCall" && event.part.status === "pending") {
					writeToolLine(`↳ planning tool call: ${event.part.name}`);
				}

				return;
			}

			if (isToolExecutionStartEvent(event)) {
				writeToolLine(`↳ running ${event.name}...`);
				return;
			}

			if (isToolExecutionEndEvent(event)) {
				const suffix = event.status === "completed" ? "done" : "error";
				writeToolLine(`↳ ${event.name}: ${suffix}`);
				return;
			}

			if (isTurnEndEvent(event)) {
				if (event.message.role === "assistant" && event.message.stopReason === "toolUse") {
					writeToolLine(`↳ model requested tool execution`);
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

async function runShell(agent: Agent.Instance): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	rl.on("SIGINT", () => {
		console.log(`\n${colors.dim}Interrupted. Type 'exit' to quit.${colors.reset}`);
		rl.prompt();
	});

	printBanner();
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
		});

		try {
			await agent.prompt([{ type: "text", text: input }]);
			renderer.finish(agent);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`\n${colors.yellow}Error: ${message}${colors.reset}\n`);
		} finally {
			unsubscribe();
		}
	}
}

async function main(): Promise<void> {
	const agent = await createAgent();
	await runShell(agent);
}

await main();
