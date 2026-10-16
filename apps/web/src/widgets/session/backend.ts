import { Bus, Codework, defineBackend, handle, Kv } from "@codeworksh/widget/backend";
import { type EventEnvelope, HistoryEntry, type Part, type SessionInfo } from "@codeworksh/widget/codework";
import { Deferred, Effect, Option, Schedule, Schema, Stream } from "effect";

import {
	Follow,
	Info,
	Interrupt,
	Json,
	Page,
	Prompt,
	type Reply,
	type Snapshot,
	snapshotKey,
	topics,
	type Update,
	type Window,
} from "./schema.ts";

const toInfo = (info: SessionInfo): Info => ({
	title: info.title,
	updated: info.updatedAt,
	...(info.project === undefined ? {} : { project: info.project }),
	...(info.model === undefined ? {} : { model: info.model }),
});

const sameInfo = Schema.toEquivalence(Info);
const sameMessage = Schema.toEquivalence(HistoryEntry);

/**
 * What changed from `before` to the fresh info and messages, in conversation order. A first seed
 * publishes nothing: no view holds a snapshot yet, and the one it loads already has everything.
 */
const changes = (before: Snapshot | undefined, info: Info, messages: ReadonlyArray<HistoryEntry>): Update[] => {
	if (before === undefined) return [];
	const previous = new Map(before.messages.map((message) => [message.id, message]));
	const current = new Set(messages.map((message) => message.id));
	return [
		...(sameInfo(before.info, info) ? [] : [{ _tag: "Info" as const, info }]),
		...[...previous.keys()].filter((id) => !current.has(id)).map((id) => ({ _tag: "Removed" as const, id })),
		...messages
			.filter((message) => {
				const old = previous.get(message.id);
				return old === undefined || !sameMessage(old, message);
			})
			.map((message) => ({ _tag: "Message" as const, message })),
	];
};

/** A live text or thinking delta, as `event.subscribe` carries it. */
const Delta = Schema.Struct({
	sessionId: Schema.String,
	messageId: Schema.String,
	partIndex: Schema.Int,
	delta: Schema.String,
	timestamp: Schema.Number,
});
const decodeDelta = Schema.decodeUnknownOption(Delta);
const decodeOfSession = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }));

/** Appends a delta to the part it belongs to; a part not seen yet starts with it. */
const fold = (current: Part | undefined, kind: "text" | "thinking", delta: string): Part =>
	kind === "text"
		? current?.type === "text"
			? { ...current, text: current.text + delta }
			: { type: "text", text: delta }
		: current?.type === "thinking"
			? { ...current, thinking: current.thinking + delta }
			: { type: "thinking", thinking: delta };

const describe = (error: { readonly _tag: string }) =>
	error._tag === "SessionNotFoundError"
		? "This session no longer exists."
		: error._tag === "PromptConflictError"
			? "That message was already sent."
			: "The CodeWork server is not reachable.";

const encodeReply = Schema.encodeEffect(Json.Reply);
const encodeWindow = Schema.encodeEffect(Json.Window);
const encodeUpdate = Schema.encodeEffect(Json.Update);
const encodeSnapshot = Schema.encodeEffect(Json.Snapshot);
const decodeSnapshot = Schema.decodeUnknownEffect(Json.Snapshot);

/**
 * Keeps a copy of each followed session in kv and publishes what changes on the session's topic.
 * The copy is CodeWork's own conversation (`session.history`), refetched whenever the session's
 * durable log moves, so this backend never folds the stored events itself. What CodeWork only says
 * live, a reply's text as it streams and whether the agent works, it relays as it happens.
 */
export const session = defineBackend({
	package: "codework",
	run: Effect.gen(function* () {
		const bus = yield* Bus;
		const kv = yield* Kv;
		const codework = yield* Codework;
		const scope = yield* Effect.scope;

		// A snapshot that no longer decodes was stored by an older build: it is seeded again.
		const load = (id: string) =>
			kv.get(snapshotKey(id)).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeed(undefined),
						onSome: (json) => decodeSnapshot(json).pipe(Effect.orElseSucceed(() => undefined)),
					}),
				),
			);

		/**
		 * Replies being streamed, folded from live deltas: message id to the draft as it reads now.
		 * CodeWork stores a reply's text only once it ends, so until then this is the newer copy.
		 */
		const streaming = new Map<
			string,
			{
				readonly sessionId: string;
				message: HistoryEntry;
				// Keyed by the part index deltas carry, which can skip parts that stream no text.
				readonly parts: Map<number, Part>;
			}
		>();
		// Drafts changed since they were last published.
		const dirty = new Set<string>();
		// Each session's latest snapshot, so a delta can start from the draft CodeWork stored.
		const latest = new Map<string, Snapshot>();

		/** A draft reads as streamed so far; a reply that has ended stops streaming. */
		const withStreamed = (entries: ReadonlyArray<HistoryEntry>) =>
			entries.map((entry) => {
				const streamed = streaming.get(entry.id);
				if (streamed === undefined) return entry;
				if (entry.state !== "draft") {
					streaming.delete(entry.id);
					dirty.delete(entry.id);
					return entry;
				}
				streamed.message = { ...entry, parts: streamed.message.parts };
				return streamed.message;
			});

		/** Refetches the conversation, publishes what changed, then stores the snapshot. */
		const refresh = Effect.fn("Session.refresh")(function* (id: string, cursor: number | undefined) {
			const { info, history } = yield* Effect.all({
				info: codework("session.info", { sessionId: id }),
				history: codework("session.history", { sessionId: id }),
			});
			const before = yield* load(id);
			const next = toInfo(info);
			const messages = withStreamed(history.entries);
			let seq = before?.seq ?? 0;
			// Published before the snapshot is stored, so a view never holds a snapshot newer than its cursor.
			for (const update of changes(before, next, messages)) {
				const payload = yield* encodeUpdate(update).pipe(Effect.orDie);
				seq = (yield* bus.publish({ topic: topics.session(id), payload })).seq ?? seq;
			}
			// A history entry's seq is its place in the durable log, so the newest one is where to resume.
			const resume = cursor ?? before?.cursor ?? history.entries.at(-1)?.seq;
			const snapshot: Snapshot = {
				info: next,
				messages,
				seq,
				...(resume === undefined ? {} : { cursor: resume }),
			};
			yield* kv.set(snapshotKey(id), yield* encodeSnapshot(snapshot).pipe(Effect.orDie));
			latest.set(id, snapshot);
			return snapshot;
		});

		/** Publishes to the session's live subscribers without storing it. */
		const publishLive = (sessionId: string, update: Update) =>
			encodeUpdate(update).pipe(
				Effect.orDie,
				Effect.flatMap((payload) => bus.publish({ topic: topics.session(sessionId), payload, ephemeral: true })),
				Effect.asVoid,
			);

		/** Folds what CodeWork only says live: deltas into their drafts, and whether the agent works. */
		const observe = (envelope: EventEnvelope): Effect.Effect<void> => {
			switch (envelope.type) {
				case "session.llm.text.delta":
				case "session.llm.thinking.delta": {
					const delta = Option.getOrUndefined(decodeDelta(envelope.data));
					if (delta === undefined || !following.has(delta.sessionId)) return Effect.void;
					return Effect.sync(() => {
						const streamed = streaming.get(delta.messageId);
						const draft = streamed?.message ??
							latest.get(delta.sessionId)?.messages.find((message) => message.id === delta.messageId) ?? {
								id: delta.messageId,
								seq: latest.get(delta.sessionId)?.cursor ?? 0,
								role: "assistant",
								state: "draft",
								createdAt: delta.timestamp,
								updatedAt: delta.timestamp,
								parts: [],
							};
						const kind = envelope.type === "session.llm.text.delta" ? "text" : "thinking";
						const parts = streamed?.parts ?? new Map<number, Part>();
						parts.set(delta.partIndex, fold(parts.get(delta.partIndex), kind, delta.delta));
						const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
						streaming.set(delta.messageId, {
							sessionId: delta.sessionId,
							message: { ...draft, parts: ordered },
							parts,
						});
						dirty.add(delta.messageId);
					});
				}
				case "session.execution.started":
				case "session.execution.succeeded":
				case "session.execution.failed":
				case "session.execution.interrupted": {
					const sessionId = Option.getOrUndefined(decodeOfSession(envelope.data))?.sessionId;
					if (sessionId === undefined || !following.has(sessionId)) return Effect.void;
					return publishLive(sessionId, {
						_tag: "Running",
						running: envelope.type === "session.execution.started",
					});
				}
				default:
					return Effect.void;
			}
		};

		// Drafts go out at most every 50ms, however fast the deltas arrive.
		const flush = Effect.suspend(() => {
			const ids = [...dirty];
			dirty.clear();
			return Effect.forEach(
				ids,
				(id) => {
					const streamed = streaming.get(id);
					return streamed === undefined
						? Effect.void
						: publishLive(streamed.sessionId, { _tag: "Message", message: streamed.message });
				},
				{ discard: true },
			);
		});

		const following = new Map<string, Deferred.Deferred<Reply>>();

		/** Seeds, answers `ready`, then refreshes on every move of the session's durable log. */
		const sync = (id: string, ready: Deferred.Deferred<Reply>) =>
			Effect.gen(function* () {
				const seeded = yield* refresh(id, undefined);
				yield* Deferred.succeed(ready, { _tag: "Done" });
				yield* codework("session.log", {
					sessionId: id,
					follow: true,
					...(seeded.cursor === undefined ? {} : { after: seeded.cursor }),
				}).pipe(
					Stream.map((item) => ("id" in item ? item.durable?.seq : item.seq)),
					// A turn commits several events at once; one refetch covers them all.
					Stream.debounce("50 millis"),
					Stream.runForEach((seq) => refresh(id, seq)),
				);
			}).pipe(
				Effect.catchTag("SessionNotFoundError", (error) =>
					Deferred.succeed(ready, { _tag: "Failed", message: describe(error) }).pipe(
						Effect.andThen(Effect.sync(() => following.delete(id))),
					),
				),
				// The connection dropped: start over from the stored cursor once it is back.
				Effect.retry(Schedule.spaced("1 second")),
				Effect.repeat({ while: () => following.has(id), schedule: Schedule.spaced("1 second") }),
			);

		yield* flush.pipe(Effect.repeat(Schedule.spaced("50 millis")), Effect.forkScoped);
		// Nothing here is replayed, so a reconnect only resumes from what happens next.
		yield* codework("event.subscribe", {}).pipe(
			Stream.runForEach(observe),
			Effect.retry(Schedule.spaced("1 second")),
			Effect.repeat(Schedule.spaced("1 second")),
			Effect.forkScoped,
		);

		yield* handle(topics.follow, Follow, ({ sessionId }) =>
			Effect.gen(function* () {
				let ready = following.get(sessionId);
				if (ready === undefined) {
					ready = yield* Deferred.make<Reply>();
					following.set(sessionId, ready);
					yield* Effect.forkIn(sync(sessionId, ready), scope);
				}
				return yield* encodeReply(yield* Deferred.await(ready)).pipe(Effect.orDie);
			}),
		);

		// Read from the stored snapshot, so a page and the seq it answers with always agree.
		yield* handle(
			topics.page,
			Page,
			({ sessionId, before, limit }) =>
				Effect.gen(function* () {
					const snapshot = latest.get(sessionId) ?? (yield* load(sessionId));
					if (snapshot === undefined) {
						return yield* encodeWindow({ _tag: "Failed", message: "Follow the session before paging it." }).pipe(
							Effect.orDie,
						);
					}
					const end =
						before === undefined
							? snapshot.messages.length
							: Math.max(
									0,
									snapshot.messages.findIndex((message) => message.id === before),
								);
					const start = Math.max(0, end - limit);
					const window: Window = {
						_tag: "Window",
						info: snapshot.info,
						messages: snapshot.messages.slice(start, end),
						seq: snapshot.seq,
						more: start > 0,
					};
					return yield* encodeWindow(window).pipe(Effect.orDie);
				}),
			{ ephemeral: true },
		);

		yield* handle(topics.prompt, Prompt, ({ sessionId, messageId, text, delivery }) =>
			codework("session.prompt", {
				sessionId,
				text,
				id: messageId,
				...(delivery === undefined ? {} : { delivery }),
			}).pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);

		yield* handle(topics.interrupt, Interrupt, ({ sessionId }) =>
			codework("session.interrupt", { sessionId }).pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);
	}),
});
