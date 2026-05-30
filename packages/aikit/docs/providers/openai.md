# OpenAI

The OpenAI provider for AiKit allows you to use GPT models like GPT-4o and GPT-4o mini.

## Setup

By default, the OpenAI provider uses the `OPENAI_API_KEY` environment variable.

```bash
export OPENAI_API_KEY="your-api-key-here"
```

## Language Models

You can resolve OpenAI models using the `llm()` registry function.

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

// Initialize the model
const model = await llm("openai", "gpt-4o");
```

## Example Usage

```ts
const context: Message.Context = {
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Explain recursion briefly." }],
		}),
	],
};

const message = await stream.complete(model, context);
console.log(message.parts);
```

## Provider Options

For fine-grained control, you can pass provider-specific options such as reasoning effort for models like `o1` or `o3-mini`.

```ts
await stream.complete(model, context, {
	apiKey: "custom-openai-key",
	// Example: Set reasoning effort
	reasoningEffort: "medium",
});
```
