/**
 * Minimal SSE parsing for the Codex Responses endpoint. Each event is a JSON
 * payload on `data:` lines; `[DONE]` terminates the stream.
 */
export function parseOpenAICodexSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buffer = "";

	const parseChunk = (chunk: string, controller: TransformStreamDefaultController<Record<string, unknown>>) => {
		const dataLines = chunk
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		if (dataLines.length === 0) return;

		const data = dataLines.join("\n").trim();
		if (!data || data === "[DONE]") return;

		try {
			controller.enqueue(JSON.parse(data) as Record<string, unknown>);
		} catch (cause) {
			controller.error(new Error(`Invalid OpenAI Codex SSE JSON: ${data.slice(0, 200)}`, { cause }));
		}
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Record<string, unknown>>({
			transform(value, controller) {
				buffer += decoder.decode(value, { stream: true });

				let index = buffer.indexOf("\n\n");
				while (index !== -1) {
					const chunk = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					parseChunk(chunk, controller);
					index = buffer.indexOf("\n\n");
				}
			},
			flush(controller) {
				buffer += decoder.decode();
				if (buffer.trim()) parseChunk(buffer, controller);
			},
		}),
	);
}
