import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { LLM } from "../../src/runner/llm.ts";

export const assistant = (
	input: LLM.Input,
	index: number,
	overrides: Partial<Message.AssistantMessage> = {},
): Message.AssistantMessage =>
	Message.createAssistantMessage({
		messageId: `assistant_${index}`,
		role: "assistant",
		protocol: "openai",
		provider: { id: input.provider, name: input.provider, source: "custom", env: [] },
		model: input.model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		time: { created: index, completed: index },
		parts: [{ type: "text", text: `response ${index}` }],
		...overrides,
	});

export const immediateOpen = (contexts: Message.Context[] = []): LLM.Open => {
	let responseIndex = 0;
	return (input) =>
		Effect.sync(() => {
			responseIndex += 1;
			contexts.push(input.context);
			const message = assistant(input, responseIndex);
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: message });
			events.push({ type: "text.start", partIndex: 0, partial: message });
			events.push({ type: "text.delta", partIndex: 0, delta: `response ${responseIndex}`, partial: message });
			events.push({ type: "text.end", partIndex: 0, content: `response ${responseIndex}`, partial: message });
			events.push({ type: "done", reason: "stop", message });
			return events;
		});
};
