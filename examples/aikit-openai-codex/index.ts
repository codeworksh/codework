import {
  Type,
  llm,
  stream,
  Message,
  type OpenAICodexOptions,
} from "@codeworksh/aikit";
import { getOpenAICodexApiKey } from "@codeworksh/aikit/oauth/openai/codex";

const apiKey = await getOpenAICodexApiKey();
const options: OpenAICodexOptions = {
  apiKey: apiKey,
};

const model = await llm("openai-codex", "gpt-5.4");
if (!model) throw new Error("Model not found");

const getTimeTool = Message.defineTool({
  name: "get_time",
  description: "Get the current time",
  parameters: Type.Object({
    timezone: Type.Optional(
      Type.String({ description: "Optional timezone (e.g., Asia/Kolkata)" }),
    ),
  }),
});

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

const response = await stream.complete(model, context, options);

for (const part of response.parts) {
    if (part.type === "text") {
        console.log(part.text);
    } else if (part.type === "toolCall") {
        console.log(`Tool: ${part.name}(${JSON.stringify(part.arguments)})`);
    }
}
