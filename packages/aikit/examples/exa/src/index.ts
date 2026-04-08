import { Agent, Message } from "@codeworksh/aikit";
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

const exaSearchTool = Agent.defineTool({
	name: "exa_search",
	label: "Exa Search",
	description:
		"Search Exa for people or companies relevant to sales research. Use category=company for company discovery and category=people for individual prospect discovery.",
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
				},
			};
		}
	},
});

async function createAgent(): Promise<Agent.Instance> {
	const model = process.env.AIKIT_MODEL ?? "claude-haiku-4-5-20251001";
	requireEnv("ANTHROPIC_API_KEY");
	requireEnv("EXA_API_KEY");

	const agent = await Agent.create({
		name: "exa-sales-agent",
		provider: "anthropic",
		model,
		getApiKey: async () => process.env.ANTHROPIC_API_KEY,
		initialState: {
			tools: [exaSearchTool],
		},
	});

	agent.setSystemPrompt(
		`
You are a concise sales research agent.

Use the exa_search tool whenever you need fresh company or people discovery.
Prefer company search for account targeting and people search for individual prospecting.
Return practical findings for sales outreach and include the URLs you used.
`.trim(),
	);

	return agent;
}

function printBanner(): void {
	console.log(
		`${colors.cyan}${colors.bold}╔══════════════════════════════════════════════════════════════╗
║                    aikit Exa Sales Agent                    ║
║           Interactive company and people research           ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}
`,
	);
	console.log(`${colors.dim}Type a prompt and press Enter. Type 'exit' or 'quit' to stop.${colors.reset}`);
	console.log(`${colors.dim}Try: ${defaultPrompt}${colors.reset}\n`);
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, resolve);
	});
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

	while (true) {
		const input = (await question(rl, `${colors.green}You:${colors.reset} `)).trim();
		if (!input) {
			continue;
		}

		if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
			console.log(`\n${colors.dim}Goodbye.${colors.reset}`);
			rl.close();
			return;
		}

		try {
			console.log(`\n${colors.blue}${colors.bold}Agent:${colors.reset}`);
			await agent.prompt([{ type: "text", text: input }]);
			console.log(`${getFinalAssistantText(agent)}\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`\n${colors.yellow}Error: ${message}${colors.reset}\n`);
		}
	}
}

async function main(): Promise<void> {
	const agent = await createAgent();
	await runShell(agent);
}

await main();
