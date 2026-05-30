# Anthropic

The Anthropic provider for AiKit allows you to use Claude models like Claude 3.5 Sonnet and Haiku.

## Setup

By default, the Anthropic provider uses the `ANTHROPIC_API_KEY` environment variable.

```bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

## Language Models

You can resolve Anthropic models using the `llm()` registry function.

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

// Initialize the model
const model = await llm("anthropic", "claude-3-5-sonnet-20241022");
```

## Example Usage

```ts
const context: Message.Context = {
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Write a haiku about the ocean." }],
		}),
	],
};

const s = stream(model, context);
for await (const event of s) {
	if (event.type === "text.delta") {
		process.stdout.write(event.delta);
	}
}
```

## Provider Options

For fine-grained control, you can pass provider-specific options such as thinking/reasoning parameters.

```ts
await stream.complete(model, context, {
	apiKey: "custom-api-key",
	// Example: Enable Anthropic's extended thinking (Claude Sonnet 3.5/3.7)
	thinkingEnabled: true,
	thinkingBudgetTokens: 8192,
});
```
