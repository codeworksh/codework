# Image Input

Models with vision capabilities can process images. In AiKit, you can pass images inside the multi-part message structure.

```ts
import { readFileSync } from "fs";
import { llm, stream, Message } from "@codeworksh/aikit";

const model = await llm("openai", "gpt-4o-mini");

// Load an image and convert to base64
const imageBuffer = readFileSync("chart.png");
const base64Image = imageBuffer.toString("base64");

const context: Message.Context = {
  messages: [
    Message.createUserMessage({
      role: "user",
      time: { created: Date.now() },
      parts: [
        { type: "text", text: "What is in this image?" },
        { type: "image", data: base64Image, mimeType: "image/png" }
      ]
    })
  ]
};

const response = await stream.complete(model, context);

// Access the response text
for (const part of response.parts) {
  if (part.type === "text") {
    console.log(part.text);
  }
}
```
