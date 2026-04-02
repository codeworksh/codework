# @codeworksh/aikit

Bun-native AI toolkit for building AI agents and coding-agent workflows.

## Installation

```bash
bun add @codeworksh/aikit
```

## Quick Start

```ts
import { Message, llm, stream } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Model not found");

const context: Message.Context = {
	systemPrompt: "You are a concise assistant.",
	messages: [
		{
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Say hello in one line." }],
		},
	],
};

const s = stream(model, context, {
	apiKey: process.env.ANTHROPIC_API_KEY,
});

for await (const event of s) {
	if (event.type === "text_delta") {
		process.stdout.write(event.delta);
	}
}

const message = await s.result();
console.log(message.parts);
```

## Core Concepts

### LLM

`llm(...)` resolves a model definition from the built-in registry. `stream(...)` and `stream.complete(...)` use that model to produce `AssistantMessage` output made of `message.parts`.

```ts
import { llm, stream } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Missing model");

const message = await stream.complete(
	model,
	{
		messages: [
			{
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: "Reply with exactly: ok" }],
			},
		],
	},
	{ apiKey: process.env.ANTHROPIC_API_KEY },
);
```

### Agent

`agent.loop(...)` runs a full assistant turn loop on top of model streaming. It handles tool calls, validates arguments, mutates tool-call parts in-place, and emits higher-level agent events.

```ts
import { Type } from "@sinclair/typebox";
import { Agent, Message, agent, llm } from "@codeworksh/aikit";

const calculatorParams = Type.Object({
	expression: Type.String(),
});

const calculatorTool: Agent.AgentTool<typeof calculatorParams> = {
	name: "calculator",
	label: "Calculator",
	description: "Evaluate a math expression",
	parameters: calculatorParams,
	async execute(callID, params) {
		return {
			status: "completed",
			result: {
				content: [{ type: "text", text: `${params.expression} = 4` }],
				isError: false,
			},
		};
	},
};

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Missing model");

const prompt: Message.UserMessage = {
	role: "user",
	time: { created: Date.now() },
	parts: [{ type: "text", text: "Use the calculator tool for 2 + 2." }],
};

const run = agent.loop(
	{
		model,
		convertToLlm: async (messages) => messages,
		apiKey: process.env.ANTHROPIC_API_KEY,
		beforeToolExecution: async ({ toolCall }) => {
			console.log("validated args", toolCall.args);
		},
		afterToolExecution: async ({ result }) => result,
	},
	{
		systemPrompt: "Use tools when helpful.",
		messages: [],
		tools: [calculatorTool],
	},
	[prompt],
);

for await (const event of run) {
	if (event.type === "message_part_update" && event.source === "tool") {
		console.log(event.part);
	}
}

const messages = await run.result();
console.log(messages.at(-1));
```

### Agent Vs LLM

Use `stream(...)` when you want raw provider events and manual control over tool handling.

Use `agent.loop(...)` when you want a higher-level runtime that:
- streams assistant message lifecycle events
- validates tool arguments
- executes tools sequentially or in parallel
- supports `beforeToolExecution` and `afterToolExecution` callbacks

## Event Flow

LLM streams emit low-level provider-normalized events:

```text
start
text_start / thinking_start / toolcall_start
text_delta / thinking_delta / toolcall_delta
text_end / thinking_end / toolcall_end
done | error
```

## With Tools

Agent loops emit higher-level lifecycle events around messages, parts, turns, and tools:

```text
agent_start
turn_start
message_start
message_part_start
message_part_update
message_part_end
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

Example:

```ts
import { Type } from "@sinclair/typebox";
import { Agent, Message, agent, llm } from "@codeworksh/aikit";

const searchParams = Type.Object({
	query: Type.String(),
	limit: Type.Optional(Type.Number()),
});

const searchTool: Agent.AgentTool<typeof searchParams, { progress: number }, { hits: number }> = {
	name: "search",
	label: "Search",
	description: "Search indexed documents",
	parameters: searchParams,
	async execute(callID, params, signal, onUpdate) {
		onUpdate?.({
			status: "running",
			partial: {
				content: [{ type: "text", text: `Searching for ${params.query}` }],
				details: { progress: 50 },
			},
		});

		return {
			status: "completed",
			result: {
				content: [{ type: "text", text: `Found results for ${params.query}` }],
				details: { hits: 3 },
				isError: false,
			},
		};
	},
};

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Missing model");

const prompt: Message.UserMessage = {
	role: "user",
	time: { created: Date.now() },
	parts: [{ type: "text", text: "Search for agent loop documentation." }],
};

const run = agent.loop(
	{
		model,
		apiKey: process.env.ANTHROPIC_API_KEY,
		convertToLlm: async (messages) => messages,
		toolExecution: "parallel",
	},
	{
		systemPrompt: "Use tools when useful.",
		messages: [],
		tools: [searchTool],
	},
	[prompt],
);

for await (const event of run) {
	if (event.type === "tool_execution_start") {
		console.log("tool started", event.name, event.args ?? event.rawArgs);
	}

	if (event.type === "tool_execution_update") {
		console.log("tool update", event.partial?.details);
	}

	if (event.type === "tool_execution_end") {
		console.log("tool finished", event.result.details);
	}
}
```

### Tool Execution Modes

Tool execution mode is configurable with `toolExecution`:

- `parallel`: prepares tool calls in assistant order, then executes allowed calls concurrently. This is the default and is usually the right choice for independent tools.
- `sequential`: prepares and executes each tool call one by one. Use this when tools depend on shared state, rate limits, or side effects that should not overlap.

```ts
const run = agent.loop(
	{
		model,
		convertToLlm: async (messages) => messages,
		toolExecution: "sequential",
	},
	context,
	[prompt],
);
```

### beforeToolExecution

`beforeToolExecution` runs after tool arguments have been validated and before the tool executes.

Use it to inspect validated params, enforce policy, or block execution.

```ts
const run = agent.loop(
	{
		model,
		convertToLlm: async (messages) => messages,
		beforeToolExecution: async ({ toolCall }) => {
			if (toolCall.name === "search" && toolCall.args?.query === "secret") {
				return {
					block: true,
					reason: "This query is not allowed",
				};
			}
		},
	},
	context,
	[prompt],
);
```

Returning `{ block: true }` prevents the tool from running and turns that assistant tool-call part into an error result.

### afterToolExecution

`afterToolExecution` runs after the tool finishes and before the terminal tool result is emitted.

Use it to normalize output, attach metadata, or override the final tool result.

```ts
const run = agent.loop(
	{
		model,
		convertToLlm: async (messages) => messages,
		afterToolExecution: async ({ result }) => {
			if (result.status === "completed") {
				return {
					status: "completed",
					result: {
						...result.result,
						details: {
							...result.result.details,
							source: "post-processed",
						},
					},
				};
			}
		},
	},
	context,
	[prompt],
);
```

## Public API

The root package exports the facades and core namespaces used to build on top of `aikit`:

```ts
import {
	agent,
	llm,
	stream,
	Agent,
	Event,
	Message,
	Model,
	Stream,
	validateToolArguments,
	validateToolCall,
} from "@codeworksh/aikit";
```
