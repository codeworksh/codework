import { Type } from "@sinclair/typebox";
import { Agent } from "../src/agent/agent";

type Assert<T extends true> = T;
type IsEqual<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;

const searchParams = Type.Object({
	query: Type.String(),
	limit: Type.Optional(Type.Number()),
});

type UpdateDetails = {
	progress: number;
	stage?: string;
};

type ResultDetails = {
	hits: number;
	source: "cache" | "network";
};

const searchTool: Agent.AgentTool<typeof searchParams, UpdateDetails, ResultDetails> = {
	name: "search",
	label: "Search",
	description: "Search indexed documents",
	parameters: searchParams,
	async execute(toolCallID, params, signal, onUpdate) {
		type Params = typeof params;
		type _paramsAssert = Assert<IsEqual<Params, { query: string; limit?: number }>>;

		const _signal: AbortSignal | undefined = signal;
		const _toolCallID: string = toolCallID;
		void _signal;
		void _toolCallID;

		await onUpdate?.({
			status: "running",
			partial: {
				content: [{ type: "text", text: `Searching for ${params.query}` }],
				details: { progress: 50, stage: "querying" },
			},
		});

		return {
			status: "completed",
			result: {
				content: [{ type: "text", text: "Done" }],
				isError: false,
				details: { hits: 12, source: "network" },
			},
		};
	},
};

const calculatorTool = Agent.defineTool({
	name: "calculator",
	label: "Calculator",
	description: "Evaluates arithmetic expressions",
	parameters: Type.Object({
		expression: Type.String(),
	}),
	async execute(_toolCallID, params) {
		type Params = typeof params;
		type _paramsAssert = Assert<IsEqual<Params, { expression: string }>>;

		return {
			status: "completed",
			result: {
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		};
	},
});

type ExecuteParams = Parameters<typeof searchTool.execute>[1];
type ExecuteUpdateCallback = NonNullable<Parameters<typeof searchTool.execute>[3]>;
type ExecuteReturn = Awaited<ReturnType<typeof searchTool.execute>>;
type UpdateEvent = Parameters<ExecuteUpdateCallback>[0];
type _executeParamsAssert = Assert<IsEqual<ExecuteParams, { query: string; limit?: number }>>;
type _executeReturnAssert = Assert<IsEqual<ExecuteReturn, Agent.ToolTerminalResult<ResultDetails>>>;
type _updateEventAssert = Assert<IsEqual<UpdateEvent, Agent.ToolRunningResult<UpdateDetails>>>;
type DefineToolParams = Parameters<typeof calculatorTool.execute>[1];
type _defineToolParamsAssert = Assert<IsEqual<DefineToolParams, { expression: string }>>;

const agentState = {
	name: "main",
	systemPrompt: "Be concise.",
	model: {} as never,
	thinkingLevel: "medium" as never,
	tools: [searchTool],
	messages: [],
	isStreaming: false,
	streamMessage: null,
	pendingToolCalls: new Set<string>(),
} satisfies Agent.State;

const agentContext = {
	systemPrompt: "Be concise.",
	messages: [],
	tools: [searchTool],
} satisfies Agent.AgentContext;

void agentState;
void agentContext;
