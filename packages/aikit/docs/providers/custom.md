# Custom Models

You can use AiKit with any provider or custom proxy endpoint by manually defining a `Model.TModel` object. This is especially useful for local models via Ollama or proxies like LiteLLM using the `openai-compatible` protocol.

## Using Ollama (OpenAI Compatible)

Ollama provides a local OpenAI-compatible server. We can create a custom model definition for it and pass it directly to `stream()` or `stream.complete()`.

```ts
import { Model, stream, Message } from "@codeworksh/aikit";

// Define a custom Ollama model using the openai-compatible protocol
const ollamaModel: Model.TModel<"openai-compatible"> = {
	id: "llama3.1",
	name: "Llama 3.1 8B (Ollama)",
	protocol: "openai-compatible",
	provider: {
		id: "ollama",
		name: "Ollama",
		source: "custom",
		env: [],
	},
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};

// Setup a simple conversation
const context: Message.Context = {
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Why is the sky blue?" }],
		}),
	],
};

// Start generation (no API key required for local Ollama, but some models expect a dummy string)
const s = stream(ollamaModel, context, { apiKey: "dummy" });

for await (const event of s) {
	if (event.type === "text.delta") {
		process.stdout.write(event.delta);
	}
}
```

## Proxies and Custom Headers

If you are communicating with a custom proxy or corporate gateway, you can also pass custom HTTP headers or tweak options directly in the model definition.

```ts
const proxyModel: Model.TModel<"anthropic"> = {
	id: "claude-3-5-sonnet-20241022",
	name: "Claude Sonnet 3.5 (Proxied)",
	protocol: "anthropic",
	provider: {
		id: "custom-proxy",
		name: "Custom Proxy",
		source: "custom",
		env: [],
	},
	baseUrl: "https://proxy.example.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
	headers: {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
		"X-Custom-Auth": "bearer-token-here",
	},
};
```
