import { EventSourceParserStream, type EventSourceMessage } from "eventsource-parser/stream";

/** Parse standards-compliant event streams from the Codex Responses endpoint. */
export function parseOpenAICodexSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<Record<string, unknown>> {
	const decoder = new TextDecoder();
	return body
		.pipeThrough(
			new TransformStream<Uint8Array, string>({
				transform(chunk, controller) {
					const text = decoder.decode(chunk, { stream: true });
					if (text) controller.enqueue(text);
				},
				flush(controller) {
					const text = decoder.decode();
					if (text) controller.enqueue(text);
				},
			}),
		)
		.pipeThrough(new EventSourceParserStream({ onError: "terminate" }))
		.pipeThrough(
			new TransformStream<EventSourceMessage, Record<string, unknown>>({
				transform(event, controller) {
					const data = event.data.trim();
					if (!data || data === "[DONE]") return;

					try {
						const parsed: unknown = JSON.parse(data);
						if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
							throw new TypeError("codex SSE data must be a JSON object");
						}
						controller.enqueue(parsed as Record<string, unknown>);
					} catch (cause) {
						controller.error(new Error(`invalid OpenAI Codex SSE JSON: ${data.slice(0, 200)}`, { cause }));
					}
				},
			}),
		);
}
