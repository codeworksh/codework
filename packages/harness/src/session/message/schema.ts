// The conversation message id, shared with plugins: it identifies the message a tool call
// belongs to on every `beforeToolCall` / `afterToolCall` hook.
export { MessageID as ID } from "@codeworksh/plugin/ids";

export * as SessionMessageSchema from "./schema.ts";
