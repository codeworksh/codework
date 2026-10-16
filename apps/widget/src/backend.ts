import { Context, type Duration, type Effect, type Option, type Schema, type Scope, type Stream } from "effect";
import type { Event, EventTimeout, Publish, Request, Synced } from "./event.ts";

/** The event log as a backend sees it: `source` is its package, and it publishes only under it. */
export class Bus extends Context.Service<
	Bus,
	{
		readonly publish: (input: Omit<Publish, "source">) => Effect.Effect<Event>;
		readonly request: (
			input: Omit<Request, "source">,
			timeout?: Duration.Input,
		) => Effect.Effect<Event, EventTimeout>;
		readonly subscribe: (input: {
			readonly topics: ReadonlyArray<string>;
			readonly after?: number | undefined;
		}) => Stream.Stream<Event | Synced>;
	}
>()("@codeworksh/widget/backend/Bus") {}

/** JSON storage scoped to the backend's package; the same keys its views read. */
export class Kv extends Context.Service<
	Kv,
	{
		readonly get: (key: string) => Effect.Effect<Option.Option<Schema.Json>>;
		readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>;
	}
>()("@codeworksh/widget/backend/Kv") {}

/**
 * A package's backend. `run` starts it, forking whatever it keeps running into its scope; closing
 * the scope stops it.
 */
export interface Backend {
	/** The package its topics and kv keys belong to, e.g. "codework". */
	readonly package: string;
	readonly run: Effect.Effect<void, never, Bus | Kv | Scope.Scope>;
}

export const defineBackend = (backend: Backend): Backend => backend;
