import { Bus, Codework, defineBackend, handle, Kv } from "@codeworksh/widget/backend";
import { HistoryEntry, type SessionInfo } from "@codeworksh/widget/codework";
import { Deferred, Effect, Option, Schedule, Schema, Stream } from "effect";

import {
	Follow,
	Info,
	Interrupt,
	Json,
	Prompt,
	type Reply,
	type Snapshot,
	snapshotKey,
	topics,
	type Update,
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

const describe = (error: { readonly _tag: string }) =>
	error._tag === "SessionNotFoundError"
		? "This session no longer exists."
		: error._tag === "PromptConflictError"
			? "That message was already sent."
			: "The CodeWork server is not reachable.";

const encodeReply = Schema.encodeEffect(Json.Reply);
const encodeUpdate = Schema.encodeEffect(Json.Update);
const encodeSnapshot = Schema.encodeEffect(Json.Snapshot);
const decodeSnapshot = Schema.decodeUnknownEffect(Json.Snapshot);

/**
 * Keeps a copy of each followed session in kv and publishes what changes on the session's topic.
 * The copy is CodeWork's own conversation (`session.history`), refetched whenever the session's
 * durable log moves, so this backend never has to fold harness events itself.
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

		/** Refetches the conversation, publishes what changed, then stores the snapshot. */
		const refresh = Effect.fn("Session.refresh")(function* (id: string, cursor: number | undefined) {
			const { info, history } = yield* Effect.all({
				info: codework("session.info", { sessionId: id }),
				history: codework("session.history", { sessionId: id }),
			});
			const before = yield* load(id);
			const next = toInfo(info);
			let seq = before?.seq ?? 0;
			// Published before the snapshot is stored, so a view never holds a snapshot newer than its cursor.
			for (const update of changes(before, next, history.entries)) {
				const payload = yield* encodeUpdate(update).pipe(Effect.orDie);
				seq = (yield* bus.publish({ topic: topics.session(id), payload })).seq ?? seq;
			}
			// A history entry's seq is its place in the durable log, so the newest one is where to resume.
			const resume = cursor ?? before?.cursor ?? history.entries.at(-1)?.seq;
			const snapshot: Snapshot = {
				info: next,
				messages: history.entries,
				seq,
				...(resume === undefined ? {} : { cursor: resume }),
			};
			yield* kv.set(snapshotKey(id), yield* encodeSnapshot(snapshot).pipe(Effect.orDie));
			return snapshot;
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
