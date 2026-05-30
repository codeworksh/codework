# OpenRouter

The OpenRouter provider gives you access to a massive catalog of open-source and proprietary models through a single API.

## Setup

By default, the OpenRouter provider uses the `OPENROUTER_API_KEY` environment variable.

```bash
export OPENROUTER_API_KEY="your-api-key-here"
```

## Language Models

You can resolve OpenRouter models using the `llm()` registry function. 

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

// Initialize the model
const model = await llm("openrouter", "meta-llama/llama-3-70b-instruct");
```

## Example Usage

```ts
const context: Message.Context = {
  messages: [
    Message.createUserMessage({
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", text: "What are the benefits of TypeScript?" }],
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

OpenRouter supports dynamic API keys and additional headers (like `HTTP-Referer` and `X-Title` for app visibility):

```ts
await stream.complete(model, context, { 
  apiKey: "custom-openrouter-key",
});
```
