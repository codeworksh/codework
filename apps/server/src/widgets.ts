import { backends } from "@codeworksh/web/backends";
import { Bus, Codework, Kv as WidgetKv } from "@codeworksh/widget/backend";
import { Effect, Layer } from "effect";
import { Event } from "./event.ts";
import { Kv } from "./kv.ts";

/** A topic outside the publisher's package is a bug in the widget, not a runtime condition. */
const owned = (pkg: string, topic: string) =>
	topic.startsWith(`${pkg}/`) ? Effect.void : Effect.die(`${pkg} cannot publish to ${topic}`);

/** Starts every backend with the bus and kv scoped to its package; they stop with the server. */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const kv = yield* Kv.Service;
		const codework = yield* Codework;
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
				Effect.forkScoped,
			),
		);
	}),
);

export * as Widgets from "./widgets.ts";
