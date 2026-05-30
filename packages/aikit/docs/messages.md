# Messages & Context

Interacting with LLMs requires managing the context window. AiKit uses a robust `Message.Context` format to represent conversation state.

## Context Structure

A `Message.Context` object contains:

- `systemPrompt`: High-level instructions for the model's behavior.
- `messages`: An array of messages from the user, assistant, or tool executions.
- `tools` _(optional)_: An array of executable tools the model has access to.

```ts
import { Message } from "@codeworksh/aikit";

const context: Message.Context = {
	systemPrompt: "You are an expert software engineer.",
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Explain how promises work in JS." }],
		}),
	],
};
```

## Message Parts

AiKit uses a multi-part format for messages, allowing you to pass complex payloads (like text alongside images, or text alongside tool results) in a single message envelope.

```ts
Message.createUserMessage({
	role: "user",
	time: { created: Date.now() },
	parts: [
		{ type: "text", text: "What is in this image?" },
		// Binary or URL-based parts can be added here
	],
});
```
