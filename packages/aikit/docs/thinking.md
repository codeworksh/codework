# Thinking & Reasoning

Many modern models (like Claude 3.7 Sonnet, OpenAI o1, or Gemini Pro) support thinking/reasoning capabilities where they can show their internal thought process before responding.

## Requesting Reasoning

You can enable thinking modes through the provider options passed to the `stream` or `complete` APIs.

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-3-7-sonnet-20250219");

const context: Message.Context = {
	messages: [
		{
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Solve this complex logic puzzle..." }],
		},
	],
};

// Start a stream with thinking enabled
const s = stream(model, context, {
	thinkingEnabled: true,
	thinkingBudgetTokens: 4096,
});
```

## Streaming Thinking Content

When streaming, thinking content is delivered separately from standard text output. You can catch this via the `reasoning.delta` (or equivalent based on Vercel AI SDK integration) event type.

```ts
for await (const event of s) {
	if (event.type === "reasoning.delta") {
		process.stdout.write(event.delta); // Stream the model's internal thoughts
	} else if (event.type === "text.delta") {
		process.stdout.write(event.delta); // Stream the final text response
	}
}
```

The final message object will include reasoning content directly in its parts if the model emitted any.
