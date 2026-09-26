import { describe, expect, it } from "vite-plus/test";
import { EventStream } from "../src/utils/eventstream.ts";

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
	it("ignores pushes after completion", async () => {
		const stream = makeStream();
		stream.push({ kind: "final", value: 1 });
		stream.push({ kind: "data", value: 99 });

		const events = await collect(stream);
		expect(events.map((e) => e.value)).toEqual([1]);
		await expect(stream.result()).resolves.toBe(1);
	});

	it("drains queued events even after end()", async () => {
		const stream = makeStream();
		stream.push({ kind: "data", value: 1 });
		stream.end(0);

		const events = await collect(stream);
		expect(events.map((e) => e.value)).toEqual([1]);
	});
});
