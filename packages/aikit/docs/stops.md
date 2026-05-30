# Stop Reasons

When generating a response, it's useful to know why the model stopped producing tokens.

Every completed message in AiKit includes a `stopReason` property that indicates how the generation ended:

- `"stop"` - Normal completion, the model finished its response.
- `"length"` - The output hit the maximum token limit.
- `"toolUse"` - The model is calling tools and expects tool results to be returned.
- `"error"` - An error occurred during generation.
- `"cancel"` - The request was cancelled.

```ts
const message = await stream.complete(model, context);

if (message.stopReason === "length") {
  console.warn("The model hit the token limit before finishing.");
} else if (message.stopReason === "tool-calls") {
  console.log("The model invoked tools.");
} else {
  console.log("Finished normally.");
}
```
