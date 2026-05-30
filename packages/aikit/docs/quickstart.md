# Quickstart

Get up and running with AiKit in a few minutes.

## Installation

```bash
npm install @codeworksh/aikit
```

## First Request

Here's how to resolve a model, build a conversation context, and get a response.

```ts
import { Type, type Static, type TSchema, llm, stream, Message } from "@codeworksh/aikit";

// Resolve a model from the built-in registry
const model = await llm("openai", "gpt-4o-mini");
if (!model) throw new Error("Model not found");

// Define tools with TypeBox schemas for type safety and validation
const getTimeTool = Message.defineTool({
	name: "get_time",
	description: "Get the current time",
	parameters: Type.Object({
		timezone: Type.Optional(Type.String({ description: "Optional timezone (e.g., Asia/Kolkata)" })),
	}),
});

// Setup conversation context
const context: Message.Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "What time is it in Bengaluru?" }],
		}),
	],
	tools: [getTimeTool],
};

// Get complete response without streaming
const response = await stream.complete(model, context);

for (const part of response.parts) {
	if (part.type === "text") {
		console.log(part.text);
	} else if (part.type === "toolCall") {
		console.log(`Tool: ${part.name}(${JSON.stringify(part.arguments)})`);
	}
}
```

For handling real-time streams, check out the [Streaming](./streaming.md) section.
