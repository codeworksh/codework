# Streaming

Most LLM interactions feel faster when the response is streamed back in real-time. AiKit provides an `EventStream` primitive that makes this easy.

## Using the Stream API

Use the `stream()` function to receive an async iterable of events. This gives you fine-grained control over how to render or process tokens as they arrive.

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-haiku-4-5-20251001");
const context: Message.Context = {
  messages: [
    Message.createUserMessage({
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", text: "Write a short poem about coding." }],
    }),
  ],
};

const s = stream(model, context, { apiKey: process.env.ANTHROPIC_API_KEY });

// Consume the stream
for await (const event of s) {
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

// After streaming is complete, get the final appended message
const finalMessage = await s.result();
console.log(`\nMessage ID: ${finalMessage.messageId}`);
```

## Granular Streaming Events

AiKit emits granular events for text, thinking, and tool calls during generation. Here is a robust example that streams all event types and executes tools on completion.

```ts
import { Type, type Static, type TSchema, llm, stream, Message } from "@codeworksh/aikit";

const model = await llm("openai", "gpt-4o-mini");

// Define tools with TypeBox schemas for type safety and validation
const getTimeTool = Message.defineTool({
  name: "get_time",
  description: "Get the current time",
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: "Optional timezone (e.g., Asia/Kolkata)" }))
  })
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
  tools: [getTimeTool]
};

const s = stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case "start":
      console.log(`Starting generation...`);
      break;
    case "text.start":
      console.log("\n[Text started]");
      break;
    case "text.delta":
      process.stdout.write(event.delta);
      break;
    case "text.end":
      console.log("\n[Text ended]");
      break;
    case "thinking.start":
      console.log("[Model is thinking...]");
      break;
    case "thinking.delta":
      process.stdout.write(event.delta);
      break;
    case "thinking.end":
      console.log("[Thinking complete]");
      break;
    case "toolcall.start":
      console.log(`\n[Tool call started]`);
      break;
    case "toolcall.delta":
      console.log(`[Streaming args for tool call]`);
      break;
    case "toolcall.end":
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments:`, event.toolCall.arguments);
      break;
    case "toolcall.final":
      console.log(`\nTool call finalized`);
      break;
    case "done":
      console.log(`\nFinished: ${event.reason}`);
      break;
    case "error":
      console.error(`Error:`, event.error.errorMessage);
      break;
  }
}

// Get the final message after streaming and add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
for (let i = 0; i < finalMessage.parts.length; i++) {
  const part = finalMessage.parts[i];
  if (part.type === "toolCall" && part.status === "pending") {
    // Execute the tool
    const resultText = part.name === "get_time"
      ? new Date().toLocaleString("en-US", {
          timeZone: part.arguments.timezone || "UTC",
          dateStyle: "full",
          timeStyle: "long"
        })
      : "Unknown tool";

    // Embed the result back into the toolCall part
    finalMessage.parts[i] = {
      ...part,
      status: "completed",
      result: {
        isError: false,
        content: [{ type: "text", text: resultText }]
      }
    };
  }
}

// Continue if there were tool calls
if (finalMessage.stopReason === "toolUse") {
  const continuation = await stream.complete(model, context);
  context.messages.push(continuation);

  console.log("After tool execution:");
  for (const part of continuation.parts) {
    if (part.type === "text") console.log(part.text);
  }
}
```
