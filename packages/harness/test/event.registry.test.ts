import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { EventList } from "../src/event/list.ts";
import { EventRegistry } from "../src/event/registry.ts";
import { EventSchema } from "../src/event/schema.ts";
import { define as definePlugin, type Plugin } from "../src/plugin/plugin.ts";

const define = (type: string) => EventSchema.define({ type, schema: { value: Schema.String } });

const plugin = (id: string, ...events: ReadonlyArray<EventSchema.Definition>) =>
	definePlugin({ id, kind: "tool", events, setup: () => {} });

const reason = (plugins: ReadonlyArray<Plugin>) =>
	EventRegistry.flatten(plugins).pipe(
		Effect.flip,
		Effect.map((error) => error.reason),
		Effect.runPromise,
	);

/**
 * Registration is boot-time and loud. Every rejection here would otherwise
 * surface as a silently dropped event or a type that means two things.
 */
describe("event registry", () => {
	it("flattens registered plugin events alongside the kernel's", async () => {
		const mine = define("plugin.acme.test.events.thing");
		const definitions = await Effect.runPromise(EventRegistry.flatten([plugin("acme.test.events", mine)]));

		expect(definitions).toContain(mine);
		expect(definitions.length).toBe(EventList.Definitions.length + 1);
	});

	it("rejects a plugin type that shadows a kernel event", async () => {
		const collision = define(EventList.ExecutionSucceeded.type);
		expect(await reason([plugin("acme.test.events", collision)])).toBe("this is a kernel event type");
	});

	it("rejects the same type from two plugins, rather than letting load order decide", async () => {
		expect(
			await reason([
				plugin("acme.test.events", define("plugin.acme.test.events.thing")),
				plugin("other.test.events", define("plugin.acme.test.events.thing")),
			]),
		).toContain("plugin acme.test.events already registers this type");
	});

	it("requires the plugin's own namespace", async () => {
		expect(await reason([plugin("acme.test.events", define("acme.thing"))])).toBe(
			'plugin event types must start with "plugin.acme.test.events."',
		);
	});

	it("is the kernel set when nothing registers anything", async () => {
		expect(await Effect.runPromise(EventRegistry.flatten([plugin("acme.test.events")]))).toEqual([
			...EventList.Definitions,
		]);
	});

	it("replaces definitions atomically and keeps the previous set when validation fails", async () => {
		const first = define("plugin.acme.test.events.first");
		const second = define("plugin.acme.test.events.second");
		await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* EventRegistry.Service;
				yield* registry.replace([plugin("acme.test.events", first)]);
				expect(registry.get(first.type)).toBe(first);

				const rejected = yield* registry
					.replace([plugin("acme.test.events", second), plugin("other.test.events", second)])
					.pipe(Effect.result);
				expect(rejected._tag).toBe("Failure");
				expect(registry.get(first.type)).toBe(first);
				expect(registry.get(second.type)).toBeUndefined();
			}).pipe(Effect.provide(EventRegistry.layer()), Effect.scoped),
		);
	});
});
