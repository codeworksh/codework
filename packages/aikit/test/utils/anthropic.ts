/** A fake Anthropic Messages server for wire tests: records the request body and streams scripted SSE events. */

type Event = Record<string, unknown> & { type: string };

const encoder = new TextEncoder();

const sse = (event: Event): Uint8Array => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

export const messageStart: Event = {
	type: "message_start",
	message: { id: "msg_test", model: "test-model", role: "assistant", content: [], usage: { input_tokens: 1 } },
};

/** A complete one-word answer, from first event to `message_stop`. */
export const textReply: Event[] = [
	messageStart,
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

export interface FakeAnthropic {
	readonly fetch: typeof globalThis.fetch;
	/** The JSON body of the last request, once one arrived. */
	body(): unknown;
}

/**
 * Stream `events`, then close -- or, with `stall`, keep the connection open without
 * sending anything more until the SDK aborts it.
 */
export function fakeAnthropic(events: ReadonlyArray<Event>, options: { stall?: boolean } = {}): FakeAnthropic {
	let body: unknown;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
		body = JSON.parse(init.body);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) controller.enqueue(sse(event));
				if (!options.stall) {
					controller.close();
					return;
				}
				init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, body: () => body };
}
