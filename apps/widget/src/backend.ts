import { Context, type Duration, Effect, type Option, Schema, type Scope, Stream } from "effect";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";
import { type Api, HistoryEntry, QueuedPrompt, RunState, ThinkingLevel, ThreadRun } from "./codework.ts";
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
		/**
		 * How many subscribers follow `topic`, now and on each change; a closed window stops counting.
		 * A backend uses it to keep work going only while someone looks.
		 */
		readonly watchers: (topic: string) => Stream.Stream<number>;
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

/** The CodeWork server that owns projects and sessions is not running, or did not answer. */
export class CodeworkUnavailable extends Schema.TaggedError<CodeworkUnavailable>()("Server.CodeworkUnavailable", {
	message: Schema.String,
}) {}

/** A thread of a synced session. */
export const SyncThread = Schema.Struct({ sessionId: Schema.String, threadId: Schema.String });
export type SyncThread = typeof SyncThread.Type;

/** A thread whose detail is not synced, or not known yet; `removed` when its session or itself was deleted. */
export class SyncError extends Schema.TaggedError<SyncError>()("Server.SyncError", {
	message: Schema.String,
	removed: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * One page of a thread's line as the app holds it: `threadId`, or the session's main thread when
 * absent; the newest `limit` entries below the seq `before`, cut to `budget` bytes (1 MiB unless given).
 */
export const LineRequest = Schema.Struct({
	sessionId: Schema.String,
	threadId: Schema.optionalKey(Schema.String),
	before: Schema.optionalKey(Schema.Int),
	limit: Schema.Int,
	budget: Schema.optionalKey(Schema.Int),
});
export type LineRequest = typeof LineRequest.Type;

/** A synced thread as its view shows it, with what its session, space and project add. */
export const LineThread = Schema.Struct({
	id: Schema.String,
	sessionId: Schema.String,
	machineId: Schema.String,
	/** Its own, else its nearest titled ancestor's by the line's walk; absent while none has one. */
	title: Schema.optionalKey(Schema.String),
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
	runState: RunState,
	lastRun: Schema.optionalKey(ThreadRun),
	/** Its queued prompts wait for its next prompt instead of running by themselves. */
	parked: Schema.Boolean,
	/** Epoch milliseconds. */
	updatedAt: Schema.Finite,
	directory: Schema.String,
	hostDir: Schema.optionalKey(Schema.String),
	project: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
export type LineThread = typeof LineThread.Type;

export const ThreadLine = Schema.Struct({
	thread: LineThread,
	/** The page, oldest first: its own entries and, for a fork, its sources' up to each cut. */
	entries: Schema.Array(HistoryEntry),
	/** Its pending prompts, oldest first. */
	inbox: Schema.Array(QueuedPrompt),
	/** Whether the app holds entries of the line older than this page. */
	more: Schema.Boolean,
	/** The oldest seq of the line the app holds; older entries come with `sync.page`. Null before a first open. */
	floor: Schema.NullOr(Schema.Int),
});
export type ThreadLine = typeof ThreadLine.Type;

/**
 * The app's synced copy of every machine's CodeWork. A followed thread is opened, read by page from
 * the copy and paged below its floor; a command goes to the machine its session is on.
 */
export class Sync extends Context.Service<
	Sync,
	{
		/** Keeps a thread's detail in sync until it is closed; done once it is current, or at once while its machine is away. */
		readonly open: (ref: SyncThread) => Effect.Effect<void>;
		readonly close: (ref: SyncThread) => Effect.Effect<void>;
		/** Stores up to `limit` entries of an opened thread's line below its floor. */
		readonly page: (
			input: SyncThread & { readonly limit: number },
		) => Effect.Effect<{ readonly entries: number; readonly floor: number | null }, CodeworkUnavailable | SyncError>;
		readonly line: (input: LineRequest) => Effect.Effect<ThreadLine, SyncError>;
		/** The stored entries with these ids, with their parts, oldest first. */
		readonly entries: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<HistoryEntry>>;
		/** The CodeWork server of the machine a session is on; the default one for a session not synced yet. */
		readonly machine: (sessionId: string) => Effect.Effect<typeof Codework.Service, CodeworkUnavailable>;
		/**
		 * Done once that machine's index is applied up to its store's head now, so a row written
		 * before the call is held; at once while the machine is away.
		 */
		readonly settle: (sessionId: string) => Effect.Effect<void>;
	}
>()("@codeworksh/widget/backend/Sync") {}

/**
 * A package's backend. `run` starts it, forking whatever it keeps running into its scope; closing
 * the scope stops it.
 */
export interface Backend {
	/** The package its topics and kv keys belong to, e.g. "codework". */
	readonly package: string;
	readonly run: Effect.Effect<void, never, Bus | Kv | Codework | Sync | Scope.Scope>;
}

export const defineBackend = (backend: Backend): Backend => backend;

/**
 * Answers requests on `topic`. An event there without a `cause` is a request: its payload is
 * decoded with `request`, and what `handler` returns is published back on the topic, caused by it,
 * which is what a `request` on the other side resolves with. A payload that does not decode is
 * answered with `{ error }`. Each request runs on its own fiber, so a slow one holds up no other.
 *
 * `ephemeral` sends replies live only: right for reads whose answer is large and goes stale, which
 * the log should not keep. A retried request is then answered afresh rather than from the log.
 */
export const handle = <A, R>(
	topic: string,
	request: Schema.Decoder<A>,
	handler: (payload: A, event: Event) => Effect.Effect<Schema.Json, never, R>,
	options?: { readonly ephemeral?: boolean },
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
					Effect.flatMap((payload) =>
						bus.publish({
							topic,
							cause: event.id,
							payload,
							...(options?.ephemeral === true ? { ephemeral: true } : {}),
						}),
					),
					Effect.forkScoped,
				),
			),
			Effect.forkScoped,
		);
	});
