import { describe, expect, it } from "vite-plus/test";
import type { Event } from "../src/event/event";
import { AssistantMessageEventStream, EventStream } from "../src/utils/eventstream";
import { makeAssistantMessage, makeModel } from "./utils/fixtures";

type TestEvent = { kind: "data" | "final"; value: number };

function makeStream(): EventStream<TestEvent, number> {
	return new EventStream<TestEvent, number>(
		(event) => event.kind === "final",
		(event) => event.value,
	);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

describe("EventStream", () => {
	it("delivers queued events in order when pushed before iteration", async () => {
		const stream = makeStream();
		stream.push({ kind: "data", value: 1 });
		stream.push({ kind: "data", value: 2 });
		stream.push({ kind: "final", value: 3 });

		const events = await collect(stream);
		expect(events.map((e) => e.value)).toEqual([1, 2, 3]);
	});

	it("delivers events to a consumer that is already waiting", async () => {
		const stream = makeStream();
		const consumer = collect(stream);

		// Yield to let the consumer start awaiting before any push.
		await new Promise((resolve) => setTimeout(resolve, 0));
		stream.push({ kind: "data", value: 1 });
		stream.push({ kind: "final", value: 2 });

		const events = await consumer;
		expect(events.map((e) => e.value)).toEqual([1, 2]);
	});

	it("ends iteration after the completing event without an explicit end()", async () => {
		const stream = makeStream();
		stream.push({ kind: "final", value: 42 });

		const events = await collect(stream);
		expect(events).toHaveLength(1);
	});

	it("resolves result() from the completing event", async () => {
		const stream = makeStream();
		stream.push({ kind: "data", value: 1 });
		stream.push({ kind: "final", value: 42 });

		await expect(stream.result()).resolves.toBe(42);
	});

	it("ignores pushes after completion", async () => {
		const stream = makeStream();
		stream.push({ kind: "final", value: 1 });
		stream.push({ kind: "data", value: 99 });

		const events = await collect(stream);
		expect(events.map((e) => e.value)).toEqual([1]);
		await expect(stream.result()).resolves.toBe(1);
	});

	it("end() releases a waiting consumer", async () => {
		const stream = makeStream();
		const consumer = collect(stream);

		await new Promise((resolve) => setTimeout(resolve, 0));
		stream.end();

		const events = await consumer;
		expect(events).toEqual([]);
	});

	it("end(result) resolves result() without a completing event", async () => {
		const stream = makeStream();
		stream.end(7);
		await expect(stream.result()).resolves.toBe(7);
	});

	it("drains queued events even after end()", async () => {
		const stream = makeStream();
		stream.push({ kind: "data", value: 1 });
		stream.end(0);

		const events = await collect(stream);
		expect(events.map((e) => e.value)).toEqual([1]);
	});
});

describe("AssistantMessageEventStream", () => {
	const model = makeModel();

	it("resolves result() with the message from a done event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = makeAssistantMessage(model, { stopReason: "stop" });

		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();

		const events = await collect(stream as AsyncIterable<Event.LLMMessageEvent>);
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
		await expect(stream.result()).resolves.toBe(message);
	});

	it("resolves result() with the message from an error event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = makeAssistantMessage(model, { stopReason: "error", errorMessage: "boom" });

		stream.push({ type: "error", reason: "error", error: message });
		stream.end();

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("boom");
	});
});
