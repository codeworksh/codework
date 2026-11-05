import { readTopics, SyncChanged, syncTopics } from "@codeworksh/contract";
import {
	Bus,
	Codework,
	defineBackend,
	handle,
	type LineThread,
	Sync,
	type ThreadLine,
} from "@codeworksh/widget/backend";
import { LiveDelta, QueuedPrompt, UNTITLED } from "@codeworksh/widget/codework";
import type { Event } from "@codeworksh/widget/event";
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";

import {
	Cancel,
	type Cancelled,
	Change,
	Configure,
	Create,
	type Created,
	Follow,
	Info,
	Interrupt,
	Json,
	Page,
	Prompt,
	type Reply,
	threadKey,
	topics,
	type ThreadRef,
	type Update,
	type Window,
} from "./schema.ts";

/** Why the last run failed, while no other has started. */
const failureOf = ({ runState, lastRun }: LineThread): Info["failure"] => {
	const error = lastRun?.error;
	if (runState !== "idle" || lastRun?.outcome !== "failed" || error === undefined) return undefined;
	if (error._tag === "failed") return { kind: error.error.type, message: error.error.message };
	if (error._tag === "runFailed") return { kind: error.reason, message: error.message };
	return undefined;
};

// Metadata follows the addressed thread; placement and project belong to its session.
const toInfo = (thread: LineThread): Info => {
	const failure = failureOf(thread);
	return {
		title: thread.title ?? UNTITLED,
		updated: thread.updatedAt,
		runState: thread.runState,
		project: thread.project,
		...(thread.hostDir === undefined ? {} : { hostDir: thread.hostDir }),
		...(thread.thinkingLevel === undefined ? {} : { thinkingLevel: thread.thinkingLevel }),
		...(thread.model === undefined ? {} : { model: thread.model }),
		...(failure === undefined ? {} : { failure }),
	};
};

const sameInfo = Schema.toEquivalence(Info);
const sameQueue = Schema.toEquivalence(Schema.Array(QueuedPrompt));

const decodeChanged = Schema.decodeUnknownOption(SyncChanged);
const decodeDelta = Schema.decodeUnknownOption(LiveDelta);

const describe = (error: { readonly _tag: string }) => {
	if (error._tag === "Server.HostError" && "message" in error) return String(error.message);
	switch (error._tag) {
		case "SessionNotFoundError":
			return "This session no longer exists.";
		case "ThreadNotFoundError":
			return "This thread no longer exists.";
		case "PromptConflictError":
			return "That message was already sent.";
		case "Location.DirectoryNotFoundError":
			return "That folder no longer exists.";
		case "Location.NotDirectoryError":
			return "That path is not a folder.";
		case "RpcClientError":
		case "Server.CodeworkUnavailable":
			return "The CodeWork server is not reachable.";
		default:
			return error._tag.startsWith("Sandbox") ? "The sandbox could not start." : "The session could not start.";
	}
};

const encodeReply = Schema.encodeEffect(Json.Reply);
const encodeCancelled = Schema.encodeEffect(Json.Cancelled);
const encodeCreated = Schema.encodeEffect(Json.Created);
const encodeWindow = Schema.encodeEffect(Json.Window);
const encodeUpdate = Schema.encodeEffect(Json.Update);

/** How long a follow waits for a thread the app has not synced yet, such as a session just created. */
const ARRIVAL = "30 seconds";

/**
 * Follows threads for their views over the app's synced copy: a follow opens the thread's sync,
 * pages read the copy (fetching below its floor), and the sync's notices and live deltas for the
 * thread are forwarded on its topic. Commands go to the machine the session is on. A follow that
 * names no thread is the session's main thread.
 */
export const session = defineBackend({
	package: "codework",
	run: Effect.gen(function* () {
		const bus = yield* Bus;
		const codework = yield* Codework;
		const sync = yield* Sync;
		const scope = yield* Effect.scope;

		/** Each followed thread by its {@link threadKey}: the thread it named, and its head as last published. */
		const open = new Map<
			string,
			{ readonly sessionId: string; readonly threadId: string; info: Info; queued: ReadonlyArray<QueuedPrompt> }
		>();
		const following = new Map<string, Deferred.Deferred<Reply>>();

		/** The RPC address: the concrete thread once known, else the request (`threadId` absent is the main thread). */
		const addressed = (ref: ThreadRef) => {
			const threadId = ref.threadId ?? open.get(threadKey(ref))?.threadId;
			return threadId === undefined ? { sessionId: ref.sessionId } : { sessionId: ref.sessionId, threadId };
		};

		const publish = (key: string, update: Update, ephemeral = false) =>
			encodeUpdate(update).pipe(
				Effect.orDie,
				Effect.flatMap((payload) =>
					bus.publish({ topic: topics.thread(key), payload, ...(ephemeral ? { ephemeral: true } : {}) }),
				),
				Effect.asVoid,
			);

		/** The bus head now: a page read after it is followed by every update published past it. */
		const head = bus
			.subscribe({ topics: [] })
			.pipe(Stream.runHead, Effect.map(Option.match({ onNone: () => 0, onSome: (item) => item.seq ?? 0 })));

		/**
		 * The thread's head as app.db holds it, once it does: a session just created arrives with the
		 * next index batch. None as soon as it is known deleted, or once it has not come for a while.
		 */
		const arrival = (ref: ThreadRef) =>
			bus.subscribe({ topics: [syncTopics.changed] }).pipe(
				Stream.mapEffect((item) => {
					const removed =
						!("_tag" in item) &&
						Option.exists(decodeChanged(item.payload), (notice) => notice.removed.includes(ref.sessionId));
					if (removed) return Effect.succeed(Option.some(Option.none<ThreadLine>()));
					return sync.line({ ...ref, limit: 0 }).pipe(
						Effect.map((line) => Option.some(Option.some(line))),
						Effect.catch((error) =>
							Effect.succeed(error.removed === true ? Option.some(Option.none<ThreadLine>()) : Option.none()),
						),
					);
				}),
				Stream.filter(Option.isSome),
				Stream.runHead,
				Effect.map((found) => Option.flatten(Option.flatten(found))),
				Effect.timeoutOrElse({ duration: ARRIVAL, orElse: () => Effect.succeed(Option.none<ThreadLine>()) }),
			);

		/** Publishes the thread's info and queue where they changed since last published. */
		const refresh = (key: string) =>
			Effect.gen(function* () {
				const followed = open.get(key);
				if (followed === undefined) return;
				const line = yield* sync.line({ ...followed, limit: 0 }).pipe(Effect.option);
				if (Option.isNone(line)) return;
				const info = toInfo(line.value.thread);
				if (!sameInfo(followed.info, info)) {
					followed.info = info;
					yield* publish(key, { _tag: "Info", info });
				}
				if (!sameQueue(followed.queued, line.value.inbox)) {
					followed.queued = line.value.inbox;
					yield* publish(key, { _tag: "Queue", queued: line.value.inbox });
				}
			});

		/** Forwards a sync notice or delta for the followed thread as the updates its view applies. */
		const forward = (key: string, event: Event) =>
			Effect.gen(function* () {
				const followed = open.get(key);
				if (followed === undefined) return;
				if (event.topic !== syncTopics.changed) {
					const delta = decodeDelta(event.payload);
					if (Option.isSome(delta)) yield* publish(key, { _tag: "Delta", delta: delta.value }, true);
					return;
				}
				const notice = Option.getOrUndefined(decodeChanged(event.payload));
				if (notice === undefined) return;
				const detail = notice.threadId === followed.threadId;
				// Messages first, so a promoted prompt is in the conversation before it leaves the queue.
				if (detail && notice.entry.length > 0)
					for (const message of yield* sync.entries(notice.entry))
						yield* publish(key, { _tag: "Message", message });
				if (detail || notice.thread.length > 0 || notice.removed.length > 0) yield* refresh(key);
			});

		/** Opens the thread's sync, answers `ready` once its notices are followed, then forwards them. */
		const follow = (ref: ThreadRef, ready: Deferred.Deferred<Reply>) => {
			const key = threadKey(ref);
			return Effect.gen(function* () {
				const found = yield* arrival(ref);
				if (Option.isNone(found)) {
					following.delete(key);
					return yield* Deferred.succeed(ready, { _tag: "Failed", message: "This session no longer exists." });
				}
				const target = { sessionId: ref.sessionId, threadId: found.value.thread.id };
				yield* Effect.acquireRelease(sync.open(target), () => sync.close(target));
				open.set(key, { ...target, info: toInfo(found.value.thread), queued: found.value.inbox });
				yield* bus
					.subscribe({ topics: readTopics.line(target.threadId) })
					.pipe(
						Stream.runForEach((item) =>
							"_tag" in item
								? refresh(key).pipe(Effect.andThen(Deferred.succeed(ready, { _tag: "Done" })))
								: forward(key, item),
						),
					);
			}).pipe(Effect.scoped);
		};

		/**
		 * Stops following a thread once no view has watched its topic for a while: a view watches
		 * from just after it follows until its frame closes, and a closed window stops watching too.
		 * Its detail stays in app.db, so the next follow resumes from its cursor.
		 */
		const release = (key: string, syncing: Fiber.Fiber<unknown, unknown>) =>
			bus.watchers(topics.thread(key)).pipe(
				// Long enough to cover a view between its follow and its subscription, or a quick reopen.
				Stream.debounce("30 seconds"),
				Stream.filter((count) => count === 0),
				Stream.runHead,
				Effect.andThen(
					Effect.sync(() => {
						following.delete(key);
						open.delete(key);
					}),
				),
				Effect.andThen(Fiber.interrupt(syncing)),
			);

		yield* handle(topics.follow, Follow, (ref) =>
			Effect.gen(function* () {
				const key = threadKey(ref);
				let ready = following.get(key);
				if (ready === undefined) {
					ready = yield* Deferred.make<Reply>();
					following.set(key, ready);
					const syncing = yield* Effect.forkIn(follow(ref, ready), scope);
					yield* Effect.forkIn(release(key, syncing), scope);
				}
				return yield* encodeReply(yield* Deferred.await(ready)).pipe(Effect.orDie);
			}),
		);

		// Read from app.db; below what it holds, older entries are fetched from the machine first.
		yield* handle(
			topics.page,
			Page,
			({ before, limit, ...ref }) =>
				Effect.gen(function* () {
					const followed = open.get(threadKey(ref));
					if (followed === undefined)
						return yield* encodeWindow({ _tag: "Failed", message: "Follow the session before paging it." }).pipe(
							Effect.orDie,
						);
					const target = { sessionId: followed.sessionId, threadId: followed.threadId };
					const request = { ...target, limit, ...(before === undefined ? {} : { before }) };
					const seq = yield* head;
					const window = yield* Effect.gen(function* () {
						let line = yield* sync.line(request);
						let more = line.more;
						if (!more && line.floor !== null) {
							if (line.entries.length >= limit) more = true;
							else {
								const fetched = yield* sync
									.page({ ...target, limit: limit - line.entries.length })
									.pipe(Effect.orElseSucceed(() => ({ entries: 0, floor: null })));
								if (fetched.entries > 0) {
									line = yield* sync.line(request);
									more = true;
								}
							}
						}
						return {
							_tag: "Window",
							info: toInfo(line.thread),
							messages: line.entries,
							queued: line.inbox,
							seq,
							more,
						} satisfies Window;
					}).pipe(Effect.catch((error) => Effect.succeed<Window>({ _tag: "Failed", message: error.message })));
					return yield* encodeWindow(window).pipe(Effect.orDie);
				}),
			{ ephemeral: true },
		);

		/** Runs `use` against the CodeWork server of the machine the session is on. */
		const on = <A, E>(sessionId: string, use: (client: typeof Codework.Service) => Effect.Effect<A, E>) =>
			sync.machine(sessionId).pipe(Effect.flatMap(use));

		const prompt = ({ messageId, text, delivery, ...ref }: Prompt) =>
			on(ref.sessionId, (client) =>
				client("thread.prompt", {
					...addressed(ref),
					text,
					id: messageId,
					...(delivery === undefined ? {} : { delivery }),
				}),
			);

		const answer = <E extends { readonly _tag: string }>(effect: Effect.Effect<unknown, E>) =>
			effect.pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			);

		yield* handle(topics.prompt, Prompt, (input) => answer(prompt(input)));

		// A folder anchors the session on the host and is where its tools run. A memory sandbox has
		// no folder to name its project after, so it is named here. A new session opens on the default machine.
		yield* handle(topics.create, Create, ({ place, messageId, text, model, thinkingLevel }) =>
			codework("session.create", {
				...(place._tag === "Folder"
					? { directory: place.path, hostDir: place.path }
					: { sandbox: { driver: "memory" }, project: { name: "Memory" } }),
				runtime: {
					...(model === undefined ? {} : { model }),
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				},
			}).pipe(
				Effect.flatMap((info) =>
					prompt({ sessionId: info.session.id, messageId, text }).pipe(Effect.as(info.session.id)),
				),
				Effect.map((sessionId): Created => ({ _tag: "Created", sessionId })),
				Effect.catch((error) => Effect.succeed<Created>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((created) => encodeCreated(created).pipe(Effect.orDie)),
			),
		);

		// The thread's row moves with the change, so the notice that follows publishes the new info.
		yield* handle(topics.configure, Configure, ({ model, thinkingLevel, ...ref }) =>
			answer(
				on(ref.sessionId, (client) =>
					client("thread.configure", {
						...addressed(ref),
						runtime: {
							...(model === undefined ? {} : { model }),
							...(thinkingLevel === undefined ? {} : { thinkingLevel }),
						},
					}),
				),
			),
		);

		// A cancel that lost to promotion answers `Sent`: the prompt is in the conversation, and the
		// notice that follows shows it there.
		yield* handle(topics.cancel, Cancel, ({ messageId, ...ref }) =>
			on(ref.sessionId, (client) => client("thread.cancel", { ...addressed(ref), messageId })).pipe(
				Effect.map(({ cancelled }): Cancelled => (cancelled ? { _tag: "Cancelled" } : { _tag: "Sent" })),
				Effect.catch((error) => Effect.succeed<Cancelled>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeCancelled(reply).pipe(Effect.orDie)),
			),
		);

		yield* handle(topics.change, Change, ({ messageId, delivery, text, ...ref }) =>
			on(ref.sessionId, (client) =>
				client("thread.update", {
					...addressed(ref),
					messageId,
					...(delivery === undefined ? {} : { delivery }),
					...(text === undefined ? {} : { text }),
				}),
			).pipe(
				Effect.map(({ updated }): Reply =>
					updated ? { _tag: "Done" } : { _tag: "Failed", message: "That message was already sent." },
				),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);

		yield* handle(topics.interrupt, Interrupt, (ref) =>
			answer(on(ref.sessionId, (client) => client("thread.interrupt", addressed(ref)))),
		);
	}),
});
