import type { Host } from "@codeworksh/widget/view";
import { Effect, Fiber, Option, Schedule, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";

import { Server } from "./rpc";

type Client = typeof Server.Service;

/** Runs `use` with the app server's RPC client, on the connection the atoms already hold. */
const withClient = <A, E>(registry: AtomRegistry.AtomRegistry, use: (client: Client) => Effect.Effect<A, E>) =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* AtomRegistry.mount(registry, Server.runtime);
			const context = yield* AtomRegistry.getResult(registry, Server.runtime);
			return yield* Server.use(use).pipe(Effect.provide(context));
		}),
	);

/**
 * What a widget's hooks run on. Publishing stamps the instance as the source and stays inside the
 * widget's package; a subscription that drops resumes after the last seq it delivered.
 */
export function makeHost(input: {
	readonly registry: AtomRegistry.AtomRegistry;
	readonly package: string;
	readonly instanceId: string;
}): Host {
	const run = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
		Effect.runPromise(withClient(input.registry, use));
	const owned = (topic: string) =>
		topic.startsWith(`${input.package}/`)
			? Promise.resolve()
			: Promise.reject(new Error(`${input.package} cannot publish to ${topic}`));

	return {
		bus: {
			publish: (event) =>
				owned(event.topic).then(() =>
					run((client) => client("event.publish", { ...event, source: input.instanceId })),
				),
			request: (event) =>
				owned(event.topic).then(() =>
					run((client) => client("event.request", { ...event, source: input.instanceId })),
				),
			subscribe: ({ topics, after }, onItem) => {
				let cursor = after;
				const fiber = Effect.runFork(
					withClient(input.registry, (client) =>
						Stream.suspend(() =>
							client("event.subscribe", { topics, ...(cursor === undefined ? {} : { after: cursor }) }),
						).pipe(
							Stream.runForEach((item) =>
								Effect.sync(() => {
									// `Synced` carries the head and a stored event its own seq; an ephemeral one has none.
									if (item.seq !== undefined) cursor = item.seq;
									onItem(item);
								}),
							),
							Effect.retry(Schedule.spaced("1 second")),
						),
					),
				);
				return () => {
					Effect.runFork(Fiber.interrupt(fiber));
				};
			},
		},
		kv: {
			get: (key) => run((client) => client("kv.get", { package: input.package, key })).then(Option.getOrUndefined),
			set: (key, value) => run((client) => client("kv.set", { package: input.package, key, value })),
		},
	};
}
