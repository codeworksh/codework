import { Context, type Duration, Effect, type Option, Schema, type Scope, Stream } from "effect";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";
import type { Api } from "./codework.ts";
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
 * The CodeWork RPC server, over the app's one long-lived connection. It reconnects on its own; a
 * call made while it is down fails with `RpcClientError`, and a stream ends with it.
 */
export class Codework extends Context.Service<
	Codework,
	RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof Api>, RpcClientError.RpcClientError>
>()("@codeworksh/widget/backend/Codework") {}

/**
 * A package's backend. `run` starts it, forking whatever it keeps running into its scope; closing
 * the scope stops it.
 */
export interface Backend {
	/** The package its topics and kv keys belong to, e.g. "codework". */
	readonly package: string;
	readonly run: Effect.Effect<void, never, Bus | Kv | Codework | Scope.Scope>;
}

export const defineBackend = (backend: Backend): Backend => backend;

/**
 * Answers requests on `topic`. An event there without a `cause` is a request: its payload is
 * decoded with `request`, and what `handler` returns is published back on the topic, caused by it,
 * which is what a `request` on the other side resolves with. A payload that does not decode is
 * answered with `{ error }`. Each request runs on its own fiber, so a slow one holds up no other.
 */
export const handle = <A, R>(
	topic: string,
	request: Schema.Decoder<A>,
	handler: (payload: A, event: Event) => Effect.Effect<Schema.Json, never, R>,
) =>
	Effect.gen(function* () {
		const bus = yield* Bus;
		const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(request));
		yield* bus.subscribe({ topics: [topic] }).pipe(
			Stream.filter((item): item is Event => !("_tag" in item) && item.cause === undefined),
			Stream.runForEach((event) =>
				decode(event.payload).pipe(
					Effect.matchEffect({
						onFailure: (error) => Effect.succeed<Schema.Json>({ error: error.message }),
						onSuccess: (payload) => handler(payload, event),
					}),
					Effect.flatMap((payload) => bus.publish({ topic, cause: event.id, payload })),
					Effect.forkScoped,
				),
			),
			Effect.forkScoped,
		);
	});
