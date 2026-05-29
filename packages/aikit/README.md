# @codeworksh/aikit

@codeworksh/aikit is a **TypeScript SDK** for building AI agents and agentic harnesses. It provides a unified API for working with multiple LLM providers, built on top of the Vercel AI SDK, with full support for tool calling (function calling) required for agentic workflows.

It gives you the basic primitives for streaming LLM responses without the extra bloat, letting you handle the orchestration yourself.

## Table of Contents

- [Installation](#installation)
- [Supported Providers](#supported-providers)
- [Quick Start](#quick-start)
- [Tools](#tools)
- [Providers and Models](#providers-and-models)
- [CLI Tools](#cli-tools)
  - [Model Generation](#model-generation)
  - [OAuth Providers](#oauth-providers)
- [Contribute](#contribute)

## Installation

```bash
npm install @codeworksh/aikit
```

Node `>=24.14.1` is required.

## Supported Providers

Built on top of the Vercel AI SDK, `@codeworksh/aikit` supports a wide array of providers natively:

- **Anthropic** (`@ai-sdk/anthropic`)
- **OpenAI** (`@ai-sdk/openai`)
- **Google** (`@ai-sdk/google`)
- **Google Vertex AI** (`@ai-sdk/google-vertex`)
- **xAI** (`@ai-sdk/xai`)
- **OpenRouter** (`@openrouter/ai-sdk-provider`)
- **OpenAI Compatible APIs** (`@ai-sdk/openai-compatible`)

## Quick Start

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

// Resolve a model from the built-in registry
const model = await llm("anthropic", "claude-haiku-4-5-20251001");
if (!model) throw new Error("Model not found");

// Setup conversation context
const context: Message.Context = {
  systemPrompt: "You are a helpful coding assistant.",
  messages: [
    Message.createUserMessage({
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", text: "Write a simple loop in TypeScript." }],
    }),
  ],
};

// Option 1: Stream events
const s = stream(model, context, { apiKey: process.env.ANTHROPIC_API_KEY });

for await (const event of s) {
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

const finalMessage = await s.result();
console.log(`\nMessage ID: ${finalMessage.messageId}`);

// Option 2: Get complete response without streaming
const message = await stream.complete(model, context, { apiKey: process.env.ANTHROPIC_API_KEY });
console.log(message.parts);
```

## Tools

Tools enable LLMs to interact with external systems. `@codeworksh/aikit` provides native support for function calling and schema validation using TypeBox.

```ts
import { Type } from "@sinclair/typebox";
import { llm, stream, Message, validateToolArguments } from "@codeworksh/aikit";

const calculatorTool = {
  name: "calculator",
  description: "Evaluate arithmetic expressions",
  parameters: Type.Object({
    expression: Type.String(),
  }),
};

const context: Message.Context = {
  messages: [
    Message.createUserMessage({
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", text: "What is 25 * 18?" }],
    }),
  ],
  tools: [calculatorTool],
};

const response = await stream.complete(model, context, { apiKey: process.env.ANTHROPIC_API_KEY });

// Check for tool calls in the response
for (const part of response.parts) {
  if (part.type === "toolCall") {
    console.log(`Executing tool: ${part.name}`);
    
    // Validates arguments against TypeBox schema automatically
    const args = validateToolArguments(calculatorTool.parameters, part.arguments);
    // Execute your tool logic here...
  }
}
```

## Providers and Models

`@codeworksh/aikit` uses a registry to fetch model specifications and metadata. 

```ts
import { llm } from "@codeworksh/aikit";

// Get all available providers
const providers = await llm.providers();
console.log(providers);

// Get all models for a specific provider
const anthropicModels = await llm.models("anthropic");

// Get a specific model directly
const gpt4 = await llm.model("openai", "gpt-4o");
```

## CLI Tools

`@codeworksh/aikit` ships with a CLI tool for managing local metadata and authentication.

You can invoke it using `npx aikit` or `pnpm aikit`.

### Model Generation

Generate a `models.gen.json` file fetching the latest metadata about providers and their available models from `models.dev`.

```bash
pnpm aikit modelgen [path]
```

### OAuth Providers

Manage OAuth credentials for providers that require it, such as OpenAI Codex.

```bash
# Start an OAuth login flow in your browser
pnpm aikit auth --openai-codex

# Check the status of your stored credentials
pnpm aikit auth --openai-codex --status

# Refresh your current credentials
pnpm aikit auth --openai-codex --refresh

# Clear stored credentials
pnpm aikit auth --openai-codex --logout
```

## Contribute

`@codeworksh/aikit` is open to community contribution. Please ensure you submit an issue before submitting a pull request. The project prefers open community discussion before accepting new features.
