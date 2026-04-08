# @codeworksh/aikit

Toolkit for building AI agents and streaming LLM workflows.

## Installation

```bash
npm install @codeworksh/aikit
```

Node `>=24.14.1` is required.

## What You Get

- `llm(...)` to resolve a model from the built-in registry
- `stream(...)` and `stream.complete(...)` for provider-normalized LLM streaming
- `Agent.create(...)` for a stateful agent instance
- `agent.loop(...)` and `agent.loopContinue(...)` for lower-level turn orchestration
- `Message` helpers for typed messages and generated `messageId` values

## Quick Start

```ts
import { Message, llm, stream } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Model not found");

const message = await stream.complete(
	model,
	{
		systemPrompt: "You are a concise assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: "Reply with exactly: hello" }],
			}),
		],
	},
	{
		apiKey: process.env.ANTHROPIC_API_KEY,
	},
);

console.log(message.messageId);
console.log(message.parts);
```

## Stream Events

Use `stream(...)` when you want token and part-level events.

```ts
import { Message, llm, stream } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Model not found");

const s = stream(
	model,
	{
		messages: [
			Message.createUserMessage({
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: "Count from 1 to 3" }],
			}),
		],
	},
	{ apiKey: process.env.ANTHROPIC_API_KEY },
);

for await (const event of s) {
	if (event.type === "text.delta") {
		process.stdout.write(event.delta);
	}
}

const finalMessage = await s.result();
console.log(finalMessage.messageId);
```

## Agent Instance

`Agent.create(...)` is the simplest way to work with a stateful agent.

```ts
import { Agent } from "@codeworksh/aikit";

const agent = await Agent.create({
	provider: "anthropic",
	model: "claude-haiku-4-5-20251001",
	getApiKey: async () => process.env.ANTHROPIC_API_KEY,
});

agent.setSystemPrompt("Be concise.");

agent.subscribe((event) => {
	if (event.type === "message.end") {
		console.log(event.message.role, event.message.messageId);
	}
});

await agent.prompt([{ type: "text", text: "Say hello in one line." }]);

console.log(agent.state.messages);
```

## With Tools

```ts
import { Type } from "@sinclair/typebox";
import { Agent } from "@codeworksh/aikit";

const calculatorTool = Agent.defineTool({
	name: "calculator",
	label: "Calculator",
	description: "Evaluate arithmetic expressions",
	parameters: Type.Object({
		expression: Type.String(),
	}),
	async execute(_callID, params) {
		return {
			status: "completed",
			result: {
				content: [{ type: "text", text: `result for ${params.expression}` }],
				isError: false,
			},
		};
	},
});

const instance = await Agent.create({
	provider: "anthropic",
	model: "claude-haiku-4-5-20251001",
	getApiKey: async () => process.env.ANTHROPIC_API_KEY,
	initialState: {
		tools: [calculatorTool],
	},
});

await instance.prompt([{ type: "text", text: "Use the calculator tool for 25 * 18." }]);
```

## Message IDs

Every user and assistant message has a `messageId`.

Use the helpers when constructing messages yourself:

```ts
import { Message } from "@codeworksh/aikit";

const userMessage = Message.createUserMessage({
	role: "user",
	time: { created: Date.now() },
	parts: [{ type: "text", text: "hello" }],
});

console.log(userMessage.messageId);
```

This is useful for persistence layers like SQLite, event reconciliation, and updating stored messages by identity instead of array position.

## Lower-Level APIs

- `stream(...)`: raw provider-normalized stream
- `stream.complete(...)`: final assistant message without manual iteration
- `Agent.create(...)`: stateful agent instance
- `agent.loop(...)`: lower-level agent loop
- `agent.loopContinue(...)`: continue from an existing context

API docs can be added later. For now, the tests under `packages/aikit/test/` are the best reference for concrete usage.
