import Type from "typebox";
import { StreamStore } from "@durable-streams/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

process.env.CODEWORK_HOME_DIR = "/tmp/codework-agent-stream-test";

vi.mock("../../src/project/project.ts", () => ({
	Project: {
		fromDirectory: vi.fn(async (_directory: string) => ({
			project: {
				id: "test-project",
				time: {
					created: Date.now(),
					updated: Date.now(),
				},
				vcs: "unknown",
				worktree: "/",
			},
			worktree: "/",
		})),
	},
}));

const { Stream } = await import("../../src/streaming/stream");
const { Bus } = await import("../../src/streaming/bus");
const { BusEvent } = await import("../../src/streaming/event");
const { Instance } = await import("../../src/project/instance");

type StreamHandle = Awaited<ReturnType<typeof Stream.create>>;

afterEach(async () => {
	await Instance.disposeAll();
});

async function readJson<T>(handle: StreamHandle) {
	const response = await handle.client.stream<T>({
		offset: "-1",
		live: false,
		json: true,
	});
	return response.json<T>();
}

async function waitForJson<T>(handle: StreamHandle, count: number) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const items = await readJson<T>(handle);
		if (items.length >= count) return items;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${count} stream item(s)`);
}

describe("Stream", () => {
	it("keeps each handle bound to the store it was created with", async () => {
		const firstStore = new StreamStore();
		const secondStore = new StreamStore();

		const first = await Stream.create("/first", { store: firstStore, producerId: "first-producer" });
		const second = await Stream.create("/second", { store: secondStore, producerId: "second-producer" });

		await first.append({ source: "first" });
		await second.append({ source: "second" });

		expect(await readJson(first)).toEqual([{ source: "first" }]);
		expect(await readJson(second)).toEqual([{ source: "second" }]);

		const firstStoreSecondPath = await first.fetch(new URL("/second", first.url), { method: "HEAD" });
		const secondStoreFirstPath = await second.fetch(new URL("/first", second.url), { method: "HEAD" });
		expect(firstStoreSecondPath.status).toBe(404);
		expect(secondStoreFirstPath.status).toBe(404);
	});

	it("writes through the idempotent producer and remains readable through the client", async () => {
		const handle = await Stream.create("/producer", {
			store: new StreamStore(),
			producerId: "test-producer",
		});

		await handle.append({ seq: 1 });

		expect(handle.producer.nextSeq).toBe(1);
		expect(await readJson(handle)).toEqual([{ seq: 1 }]);
	});

	it("supports lifecycle operations through the custom fetch adapter", async () => {
		const handle = await Stream.create("/lifecycle", {
			store: new StreamStore(),
			producerId: "lifecycle-producer",
		});

		await handle.client.close({ body: JSON.stringify({ done: true }) });

		const read = await handle.client.stream<{ done: boolean }>({
			offset: "-1",
			live: "sse",
			json: true,
		});
		expect(await read.json()).toEqual([{ done: true }]);
		expect(read.streamClosed).toBe(true);

		const tail = await handle.fetch(`${handle.url}?offset=now`);
		expect(tail.headers.get("Stream-Closed")).toBe("true");

		await handle.client.delete();
		const head = await handle.fetch(handle.url, { method: "HEAD" });
		expect(head.status).toBe(404);
	});

	it("surfaces stream sequence conflicts from the adapter", async () => {
		const handle = await Stream.create("/sequenced", {
			store: new StreamStore(),
			producerId: "sequenced-producer",
		});

		await handle.client.append(JSON.stringify({ seq: 1 }), { seq: "b" });

		await expect(handle.client.append(JSON.stringify({ seq: 0 }), { seq: "a" })).rejects.toThrow(/Sequence conflict/);
		expect(await readJson(handle)).toEqual([{ seq: 1 }]);
	});
});

describe("Bus", () => {
	it("publishes multiple event types to in-memory subscribers", async () => {
		const Created = BusEvent.define(
			"test.bus.memory.created",
			Type.Object({
				id: Type.String(),
			}),
		);
		const Updated = BusEvent.define(
			"test.bus.memory.updated",
			Type.Object({
				id: Type.String(),
				version: Type.Number(),
			}),
		);
		const seen: string[] = [];
		let bus: Awaited<ReturnType<typeof Bus.create>>;

		await Instance.provide({
			id: "bus-memory-test",
			directory: "/tmp/codework-bus-memory-test",
			fn: async () => {
				bus = await Bus.create();
				bus.subscribe(Created, async (event) => {
					await Promise.resolve();
					seen.push(`created:${event.properties.id}`);
				});
				bus.subscribe(Updated, (event) => {
					seen.push(`updated:${event.properties.id}:${event.properties.version}`);
				});
				bus.subscribeAll((event) => {
					seen.push(`all:${event.type}`);
				});
			},
		});

		await expect(bus!.publish(Created, { id: "one" })).resolves.toEqual([undefined, undefined]);
		await expect(bus!.publish(Updated, { id: "one", version: 2 })).resolves.toEqual([undefined, undefined]);
		expect(seen).toEqual([
			"all:test.bus.memory.created",
			"created:one",
			"updated:one:2",
			"all:test.bus.memory.updated",
		]);
	});

	it("publishes bus events to the durable stream transport", async () => {
		const Created = BusEvent.define(
			"test.bus.stream.created",
			Type.Object({
				id: Type.String(),
			}),
		);
		const Updated = BusEvent.define(
			"test.bus.stream.updated",
			Type.Object({
				id: Type.String(),
				status: Type.String(),
			}),
		);
		const store = new StreamStore();
		let bus: Awaited<ReturnType<typeof Bus.create>>;
		let reader: StreamHandle;

		await Instance.provide({
			id: "bus-stream-test",
			directory: "/tmp/codework-bus-stream-test",
			fn: async () => {
				reader = await Stream.create("/bus-stream/events", {
					store,
					producerId: "bus-stream-reader",
				});
				bus = await Bus.create({
					stream: true,
					store,
					topic: "/bus-stream/events",
					producerId: "bus-stream-producer",
				});
			},
		});

		await expect(bus!.publish(Created, { id: "one" })).resolves.toEqual([]);
		await expect(bus!.publish(Updated, { id: "one", status: "done" })).resolves.toEqual([]);
		await expect(waitForJson(reader!, 2)).resolves.toEqual([
			{
				type: "test.bus.stream.created",
				properties: {
					id: "one",
				},
			},
			{
				type: "test.bus.stream.updated",
				properties: {
					id: "one",
					status: "done",
				},
			},
		]);
	});

	it("publishes to both in-memory subscribers and the durable stream transport", async () => {
		const Event = BusEvent.define(
			"test.bus.combined",
			Type.Object({
				id: Type.String(),
			}),
		);
		const store = new StreamStore();
		const seen: string[] = [];
		let bus: Awaited<ReturnType<typeof Bus.create>>;
		let reader: StreamHandle;

		await Instance.provide({
			id: "bus-combined-test",
			directory: "/tmp/codework-bus-combined-test",
			fn: async () => {
				reader = await Stream.create("/bus-combined/events", {
					store,
					producerId: "bus-combined-reader",
				});
				bus = await Bus.create({
					stream: true,
					store,
					topic: "/bus-combined/events",
					producerId: "bus-combined-producer",
				});
				bus.subscribe(Event, async (event) => {
					await Promise.resolve();
					seen.push(`exact:${event.properties.id}`);
				});
				bus.subscribeAll((event) => {
					seen.push(`all:${event.type}`);
				});
			},
		});

		await expect(bus!.publish(Event, { id: "one" })).resolves.toEqual([undefined, undefined]);
		expect(seen).toEqual(["all:test.bus.combined", "exact:one"]);
		await expect(waitForJson(reader!, 1)).resolves.toEqual([
			{
				type: "test.bus.combined",
				properties: {
					id: "one",
				},
			},
		]);
	});

	it("keeps local subscribers independent from stream observer failures", async () => {
		class FailingAppendStore extends StreamStore {
			override async appendWithProducer(
				...args: Parameters<StreamStore["appendWithProducer"]>
			): ReturnType<StreamStore["appendWithProducer"]> {
				await super.appendWithProducer(...args);
				throw new Error("stream append failed");
			}
		}

		const Event = BusEvent.define(
			"test.bus.failure",
			Type.Object({
				id: Type.String(),
			}),
		);
		const seen: string[] = [];
		let bus: Awaited<ReturnType<typeof Bus.create>>;

		await Instance.provide({
			id: "bus-failure-test",
			directory: "/tmp/codework-bus-failure-test",
			fn: async () => {
				bus = await Bus.create({
					stream: true,
					store: new FailingAppendStore(),
					topic: "/bus-failure/events",
					producerId: "bus-failure-producer",
				});
				bus.subscribe(Event, (event) => {
					seen.push(event.properties.id);
				});
			},
		});

		await expect(bus!.publish(Event, { id: "one" })).resolves.toEqual([undefined]);
		expect(seen).toEqual(["one"]);
	});
});
