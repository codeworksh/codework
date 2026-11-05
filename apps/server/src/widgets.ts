import { backends } from "@codeworksh/web/backends";
import { Bus, Codework, Kv as WidgetKv, Sync as WidgetSync } from "@codeworksh/widget/backend";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { Event } from "./event.ts";
import { Kv } from "./kv.ts";
import { Reads } from "./reads.ts";
import { Sync } from "./sync.ts";

/** A topic outside the publisher's package is a bug in the widget, not a runtime condition. */
const owned = (pkg: string, topic: string) =>
	topic.startsWith(`${pkg}/`) ? Effect.void : Effect.die(`${pkg} cannot publish to ${topic}`);

/** Starts every backend with the bus and kv scoped to its package; they stop with the server. */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const kv = yield* Kv.Service;
		const codework = yield* Codework;
		const sync = yield* Sync.Service;
		const sql = yield* SqlClient.SqlClient;
		const read = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
			Effect.provideService(effect, SqlClient.SqlClient, sql);
		const synced = WidgetSync.of({
			open: sync.open,
			close: sync.close,
			page: sync.page,
			line: (input) => read(Reads.line(input)),
			entries: (ids) => read(Reads.entries(ids)),
			settle: sync.settle,
			// A session the index has not brought yet was just created, on the default machine.
			machine: (sessionId) =>
				sync.machineOf(sessionId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeed(codework),
							onSome: (machineId) => sync.client(machineId),
						}),
					),
				),
		});
		// Third-party packages will join the built-in backends at load time.
		yield* Effect.forEach(backends, (backend) =>
			backend.run.pipe(
				Effect.provideService(
					Bus,
					Bus.of({
						publish: (input) =>
							owned(backend.package, input.topic).pipe(
								Effect.andThen(events.publish({ ...input, source: backend.package })),
							),
						request: (input, timeout) =>
							owned(backend.package, input.topic).pipe(
								Effect.andThen(events.request({ ...input, source: backend.package }, timeout)),
							),
						subscribe: events.subscribe,
						watchers: events.watchers,
					}),
				),
				Effect.provideService(
					WidgetKv,
					WidgetKv.of({
						get: (key) => kv.get(backend.package, key),
						set: (key, value) => kv.set(backend.package, key, value),
					}),
				),
				Effect.provideService(Codework, codework),
				Effect.provideService(WidgetSync, synced),
				Effect.forkScoped,
			),
		);
	}),
);

export * as Widgets from "./widgets.ts";
