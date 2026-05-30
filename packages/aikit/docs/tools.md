# Tool Use

Tools enable LLMs to interact with external systems. `@codeworksh/aikit` provides native support for function calling and schema validation using [TypeBox](https://github.com/sinclairzx81/typebox).

## Defining a Tool

A tool consists of a name, description, and a TypeBox schema that defines its required parameters.

```ts
import { Type, llm, stream, Message, validateToolArguments } from "@codeworksh/aikit";

const calculatorTool = {
  name: "calculator",
  description: "Evaluate arithmetic expressions",
  parameters: Type.Object({
    expression: Type.String(),
  }),
};
```

## Executing Tools

Pass your tools in the `Message.Context`. If the model decides to invoke the tool, the response will contain a `toolCall` part.

```ts
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
    
    // Output: { expression: "25 * 18" }
    console.log(args);
  }
}
```
