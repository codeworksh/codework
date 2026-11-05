import { Bus, Codework, defineBackend, handle, Kv } from "@codeworksh/widget/backend";
import {
	type EventEnvelope,
	HistoryEntry,
	type Part,
	QueuedPrompt,
	type ThreadInfo,
	UNTITLED,
} from "@codeworksh/widget/codework";
import { Deferred, Effect, Fiber, Option, Schedule, Schema, Stream } from "effect";

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
	type Snapshot,
	snapshotKey,
	threadKey,
	topics,
	type ThreadRef,
	type Update,
	type Window,
} from "./schema.ts";

// Metadata follows the addressed thread; placement and project belong to its session.
const toInfo = (info: ThreadInfo, title: string | undefined): Info => ({
	title: title ?? UNTITLED,
	updated: info.updatedAt,
	...(info.session.hostDir === undefined ? {} : { hostDir: info.session.hostDir }),
	...(info.session.sandbox === undefined ? {} : { sandbox: info.session.sandbox.driver }),
	...(info.thinkingLevel === undefined ? {} : { thinkingLevel: info.thinkingLevel }),
	...(info.session.project === undefined ? {} : { project: info.session.project }),
	...(info.model === undefined ? {} : { model: info.model }),
});

const sameInfo = Schema.toEquivalence(Info);
const sameMessage = Schema.toEquivalence(HistoryEntry);
const sameQueue = Schema.toEquivalence(Schema.Array(QueuedPrompt));

/**
 * What changed from `before` to the fresh info and messages, in conversation order. A first seed
 * publishes nothing: no view holds a snapshot yet, and the one it loads already has everything.
 */
const changes = (
	before: Snapshot | undefined,
	info: Info,
	messages: ReadonlyArray<HistoryEntry>,
	queued: ReadonlyArray<QueuedPrompt>,
	streamed: (id: string) => boolean,
): Update[] => {
	if (before === undefined) return [];
	const previous = new Map(before.messages.map((message) => [message.id, message]));
	const current = new Set(messages.map((message) => message.id));
	return [
		...(sameInfo(before.info, info) ? [] : [{ _tag: "Info" as const, info }]),
		...[...previous.keys()].filter((id) => !current.has(id)).map((id) => ({ _tag: "Removed" as const, id })),
		...messages
			.filter((message) => {
				const old = previous.get(message.id);
				if (old === undefined) return true;
				// Every stored change moves an entry's updatedAt, so only a moved or streaming one is compared in full.
				const moved =
					old.updatedAt !== message.updatedAt ||
					old.state !== message.state ||
					old.parts.length !== message.parts.length;
				return (moved || streamed(message.id)) && !sameMessage(old, message);
			})
			.map((message) => ({ _tag: "Message" as const, message })),
		// After the messages, so a prompt that was promoted is in the conversation before it leaves the queue.
		...(sameQueue(before.queued, queued) ? [] : [{ _tag: "Queue" as const, queued }]),
	];
};

/** Every thread-scoped event names its thread, and the session it belongs to. */
const OfThread = { sessionId: Schema.String, threadId: Schema.String };

/** A live text or thinking delta, as `event.subscribe` carries it. */
const Delta = Schema.Struct({
	...OfThread,
	messageId: Schema.String,
	partIndex: Schema.Int,
	delta: Schema.String,
	timestamp: Schema.Number,
});
const decodeDelta = Schema.decodeUnknownOption(Delta);
const decodeOfThread = Schema.decodeUnknownOption(Schema.Struct(OfThread));
const decodeFailed = Schema.decodeUnknownOption(
	Schema.Struct({ ...OfThread, error: Schema.Struct({ type: Schema.String, message: Schema.String }) }),
);

/** Appends a delta to the part it belongs to; a part not seen yet starts with it. */
const fold = (current: Part | undefined, kind: "text" | "thinking", delta: string): Part =>
	kind === "text"
		? current?.type === "text"
			? { ...current, text: current.text + delta }
			: { type: "text", text: delta }
		: current?.type === "thinking"
			? { ...current, thinking: current.thinking + delta }
			: { type: "thinking", thinking: delta };

/** Overlays live text at its original index, preserving tools and other stored parts. */
const mergeParts = (stored: ReadonlyArray<Part>, streamed: ReadonlyMap<number, Part>): Part[] => {
	const parts = new Map(stored.map((part, index) => [index, part]));
	for (const [index, part] of streamed) parts.set(index, part);
	return [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
};

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
const encodeSnapshot = Schema.encodeEffect(Json.Snapshot);
const encodeActivity = Schema.encodeEffect(Json.Activity);
const decodeSnapshot = Schema.decodeUnknownEffect(Json.Snapshot);

/**
 * Keeps a copy of each followed thread in kv and publishes what changes on that thread's topic.
 * The copy is that thread's conversation (`thread.history`), refetched whenever its durable log
 * moves, so this backend never folds the stored events itself. What CodeWork only says live, a
 * reply's text as it streams and whether the agent works, it relays as it happens, for that thread
 * alone. A follow that names no thread is the session's main thread.
 */
export const session = defineBackend({
	package: "codework",
	run: Effect.gen(function* () {
		const bus = yield* Bus;
		const kv = yield* Kv;
		const codework = yield* Codework;
		const scope = yield* Effect.scope;

		// A snapshot that no longer decodes was stored by an older build: it is seeded again.
		const load = (key: string) =>
			kv.get(snapshotKey(key)).pipe(
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
				readonly threadId: string;
				message: HistoryEntry;
				// Keyed by the part index deltas carry, which can skip parts that stream no text.
				readonly parts: Map<number, Part>;
			}
		>();
		// Drafts changed since they were last published.
		const dirty = new Set<string>();
		// Each followed thread's latest snapshot, by its {@link threadKey}.
		const latest = new Map<string, Snapshot>();
		// The concrete thread id `thread.info` named for each follow. Live events match this, not the address.
		const open = new Map<string, { readonly sessionId: string; readonly threadId: string }>();

		const keysFor = (event: { readonly sessionId: string; readonly threadId: string }) =>
			[...open.entries()]
				.filter(([, followed]) => followed.sessionId === event.sessionId && followed.threadId === event.threadId)
				.map(([key]) => key);

		/** The RPC address: the concrete thread once known, else the request (`threadId` absent is the main thread). */
		const addressed = (ref: ThreadRef) => {
			const threadId = ref.threadId ?? open.get(threadKey(ref))?.threadId;
			return threadId === undefined ? { sessionId: ref.sessionId } : { sessionId: ref.sessionId, threadId };
		};

		/** A draft reads as streamed so far; a reply that has ended stops streaming. */
		const withStreamed = (entries: ReadonlyArray<HistoryEntry>) =>
			entries.map((entry) => {
				const streamed = streaming.get(entry.id);
				if (streamed === undefined || streamed.threadId !== entry.threadId) return entry;
				if (entry.state !== "draft") {
					streaming.delete(entry.id);
					dirty.delete(entry.id);
					return entry;
				}
				streamed.message = { ...entry, parts: mergeParts(entry.parts, streamed.parts) };
				return streamed.message;
			});

		/** A fork or subagent reads as its source until its first own prompt names it. */
		const titleOf = Effect.fn("Session.titleOf")(function* (info: ThreadInfo) {
			let current = info;
			while (current.title === undefined && current.origin.kind !== "main") {
				const source = yield* codework("thread.info", {
					sessionId: info.session.id,
					threadId: current.origin.threadId,
				}).pipe(Effect.option);
				if (Option.isNone(source)) return undefined;
				current = source.value;
			}
			return current.title;
		});

		/** Refetches the conversation, publishes what changed, then stores the snapshot. */
		const refresh = Effect.fn("Session.refresh")(function* (ref: ThreadRef, cursor: number | undefined) {
			const key = threadKey(ref);
			const target = addressed(ref);
			// In this order: a prompt promoted between the queue and history reads is then in both, never in neither.
			const info = yield* codework("thread.info", target);
			open.set(key, { sessionId: ref.sessionId, threadId: info.id });
			const queue = yield* codework("thread.queue", target);
			const history = yield* codework("thread.history", target);
			// The snapshot in memory is the newest; storage can trail it by up to a second.
			const before = latest.get(key) ?? (yield* load(key));
			const next = toInfo(info, yield* titleOf(info));
			const messages = withStreamed(history.entries);
			// One that is in both has been promoted: the conversation wins.
			const listed = new Set(messages.map((message) => message.id));
			const queued = queue.entries.filter((prompt) => !listed.has(prompt.id));
			let seq = before?.seq ?? 0;
			// Published before the snapshot is stored, so a view never holds a snapshot newer than its cursor.
			for (const update of changes(before, next, messages, queued, (id) => streaming.has(id))) {
				const payload = yield* encodeUpdate(update).pipe(Effect.orDie);
				seq = (yield* bus.publish({ topic: topics.thread(key), payload })).seq ?? seq;
			}
			// A history entry's seq is its place in the durable log, so the newest one is where to resume.
			const resume = cursor ?? before?.cursor ?? history.entries.at(-1)?.seq;
			const snapshot: Snapshot = {
				info: next,
				messages,
				queued,
				seq,
				...(resume === undefined ? {} : { cursor: resume }),
			};
			latest.set(key, snapshot);
			unsaved.add(key);
			return snapshot;
		});

		/** Publishes to the thread's live subscribers without storing it. */
		const publishLive = (key: string, update: Update) =>
			encodeUpdate(update).pipe(
				Effect.orDie,
				Effect.flatMap((payload) => bus.publish({ topic: topics.thread(key), payload, ephemeral: true })),
				Effect.asVoid,
			);

		const publishEach = (event: { readonly sessionId: string; readonly threadId: string }, update: Update) =>
			Effect.forEach(keysFor(event), (key) => publishLive(key, update), { discard: true });

		// Every session's work, followed or not, so the sidebar and tabs show it without a view open:
		// threads mid-run, and sessions whose prompt this app sent before their run starts.
		const runs = new Set<string>();
		const waking = new Set<string>();
		let shown = "";
		const working = () => [...new Set([...waking, ...[...runs].map((run) => run.split("/")[0]!)])].sort();
		const publishActivity = Effect.suspend(() => {
			const list = working();
			const key = list.join("\n");
			if (key === shown) return Effect.void;
			shown = key;
			return encodeActivity({ working: list }).pipe(
				Effect.orDie,
				Effect.flatMap((payload) => bus.publish({ topic: topics.working, payload, ephemeral: true })),
				Effect.asVoid,
			);
		});
		const track = (event: { readonly sessionId: string; readonly threadId: string }, running: boolean) =>
			Effect.suspend(() => {
				waking.delete(event.sessionId);
				const run = `${event.sessionId}/${event.threadId}`;
				if (running) runs.add(run);
				else runs.delete(run);
				return publishActivity;
			});
		const wake = (sessionId: string) =>
			Effect.suspend(() => {
				waking.add(sessionId);
				return publishActivity;
			});

		/** Folds what CodeWork only says live: deltas into their drafts, and whether the agent works. */
		const observe = (envelope: EventEnvelope): Effect.Effect<void> => {
			switch (envelope.type) {
				case "session.llm.text.delta":
				case "session.llm.thinking.delta": {
					const delta = Option.getOrUndefined(decodeDelta(envelope.data));
					const keys = delta === undefined ? [] : keysFor(delta);
					if (delta === undefined || keys.length === 0) return Effect.void;
					return Effect.sync(() => {
						const streamed = streaming.get(delta.messageId);
						// Until the conversation lists the reply, only its parts are kept: it is not published before then.
						const draft = streamed?.message ??
							keys
								.map((key) => latest.get(key)?.messages.find((message) => message.id === delta.messageId))
								.find((message) => message !== undefined) ?? {
								id: delta.messageId,
								threadId: delta.threadId,
								seq: latest.get(keys[0] ?? "")?.cursor ?? 0,
								role: "assistant" as const,
								state: "draft" as const,
								createdAt: delta.timestamp,
								updatedAt: delta.timestamp,
								parts: [],
								size: 0,
							};
						const kind = envelope.type === "session.llm.text.delta" ? "text" : "thinking";
						const parts = streamed?.parts ?? new Map<number, Part>();
						parts.set(delta.partIndex, fold(parts.get(delta.partIndex), kind, delta.delta));
						const ordered = mergeParts(draft.parts, parts);
						streaming.set(delta.messageId, {
							sessionId: delta.sessionId,
							threadId: delta.threadId,
							message: { ...draft, threadId: delta.threadId, parts: ordered },
							parts,
						});
						dirty.add(delta.messageId);
					});
				}
				// A run can fail before it reaches the model, a sandbox that is gone say, and then nothing
				// in the session's log records it: this is the only place the reason shows.
				case "session.execution.failed": {
					const failed = Option.getOrUndefined(decodeFailed(envelope.data));
					if (failed === undefined) return Effect.void;
					if (keysFor(failed).length === 0) return track(failed, false);
					return track(failed, false).pipe(
						Effect.andThen(publishEach(failed, { _tag: "Running", running: false })),
						Effect.andThen(
							publishEach(failed, {
								_tag: "Failed",
								kind: failed.error.type,
								message: failed.error.message,
							}),
						),
					);
				}
				case "session.execution.started":
				case "session.execution.succeeded":
				case "session.execution.interrupted": {
					const event = Option.getOrUndefined(decodeOfThread(envelope.data));
					if (event === undefined) return Effect.void;
					const running = envelope.type === "session.execution.started";
					return track(event, running).pipe(
						Effect.andThen(
							keysFor(event).length === 0 ? Effect.void : publishEach(event, { _tag: "Running", running }),
						),
					);
				}
				default:
					return Effect.void;
			}
		};

		// Drafts go out at most every 50ms, however fast the deltas arrive. A draft waits until the
		// conversation lists it, so a view never has it ahead of the prompt it answers.
		const flush = Effect.suspend(() => {
			const ids = [...dirty].filter((id) => {
				const streamed = streaming.get(id);
				return (
					streamed !== undefined &&
					keysFor(streamed).some((key) => latest.get(key)?.messages.some((message) => message.id === id))
				);
			});
			return Effect.forEach(
				ids,
				(id) => {
					const streamed = streaming.get(id);
					if (streamed === undefined) return Effect.void;
					const keys = keysFor(streamed).filter((key) =>
						latest.get(key)?.messages.some((message) => message.id === id),
					);
					const waiting = keysFor(streamed).some(
						(key) => !latest.get(key)?.messages.some((message) => message.id === id),
					);
					if (!waiting) dirty.delete(id);
					return Effect.forEach(keys, (key) => publishLive(key, { _tag: "Message", message: streamed.message }), {
						discard: true,
					});
				},
				{ discard: true },
			);
		});

		// Snapshots changed since they were last stored. Encoding a whole conversation on every move of
		// a busy log costs more than it saves, so they are stored at most once a second.
		const unsaved = new Set<string>();
		const save = Effect.suspend(() => {
			const keys = [...unsaved];
			unsaved.clear();
			return Effect.forEach(
				keys,
				(key) => {
					const snapshot = latest.get(key);
					return snapshot === undefined
						? Effect.void
						: encodeSnapshot(snapshot).pipe(
								Effect.orDie,
								Effect.flatMap((json) => kv.set(snapshotKey(key), json)),
							);
				},
				{ discard: true },
			);
		});

		const following = new Map<string, Deferred.Deferred<Reply>>();

		/** Seeds, answers `ready`, then refreshes on every move of this thread's durable log. */
		const sync = (ref: ThreadRef, ready: Deferred.Deferred<Reply>) => {
			const key = threadKey(ref);
			const missed = (error: { readonly _tag: string }) =>
				Deferred.succeed(ready, { _tag: "Failed" as const, message: describe(error) }).pipe(
					Effect.andThen(Effect.sync(() => following.delete(key))),
				);
			return Effect.gen(function* () {
				const seeded = yield* refresh(ref, undefined);
				const threadId = open.get(key)?.threadId;
				yield* Deferred.succeed(ready, { _tag: "Done" });
				yield* codework("session.log", {
					sessionId: ref.sessionId,
					...(threadId === undefined ? {} : { threadId }),
					follow: true,
					...(seeded.cursor === undefined ? {} : { after: seeded.cursor }),
				}).pipe(
					Stream.map((item) => ("id" in item ? item.durable?.seq : item.seq)),
					// A turn commits several events at once; one refetch covers them all.
					Stream.debounce("50 millis"),
					Stream.runForEach((seq) => refresh(ref, seq)),
				);
			}).pipe(
				Effect.catchTags({
					SessionNotFoundError: missed,
					ThreadNotFoundError: missed,
				}),
				// The connection dropped: start over from the stored cursor once it is back.
				Effect.retry(Schedule.spaced("1 second")),
				Effect.repeat({ while: () => following.has(key), schedule: Schedule.spaced("1 second") }),
			);
		};

		// Both loops outlive anything that stops them, a defect included, and say what it was: one that
		// stopped quietly would freeze every view's live updates while sends still went through.
		yield* flush.pipe(
			Effect.catchCause((cause) => Effect.logWarning("Session drafts stopped; restarting", cause)),
			Effect.repeat(Schedule.spaced("50 millis")),
			Effect.forkScoped,
		);
		yield* save.pipe(
			Effect.catchCause((cause) => Effect.logWarning("Session snapshots not stored; retrying", cause)),
			Effect.repeat(Schedule.spaced("1 second")),
			Effect.forkScoped,
		);
		// Nothing here is replayed, so a reconnect only resumes from what happens next.
		yield* codework("event.subscribe", {}).pipe(
			Stream.runForEach(observe),
			Effect.catchCause((cause) => Effect.logWarning("Session live events stopped; resubscribing", cause)),
			Effect.repeat(Schedule.spaced("1 second")),
			Effect.forkScoped,
		);

		/**
		 * Stops following a thread once no view has watched its topic for a while: a view watches
		 * from just after it follows until its frame closes, and a closed window stops watching too.
		 * The snapshot stays in kv, so the next follow refreshes it rather than seeding again.
		 */
		const release = (key: string, syncing: Fiber.Fiber<unknown, unknown>) =>
			bus.watchers(topics.thread(key)).pipe(
				// Long enough to cover a view between its follow and its subscription, or a quick reopen.
				Stream.debounce("30 seconds"),
				Stream.filter((count) => count === 0),
				Stream.runHead,
				Effect.andThen(
					Effect.sync(() => {
						const followed = open.get(key);
						following.delete(key);
						latest.delete(key);
						open.delete(key);
						if (followed === undefined) return;
						const still = [...open.values()].some(
							(item) => item.sessionId === followed.sessionId && item.threadId === followed.threadId,
						);
						if (still) return;
						for (const [id, streamed] of streaming) {
							if (streamed.sessionId !== followed.sessionId || streamed.threadId !== followed.threadId) continue;
							streaming.delete(id);
							dirty.delete(id);
						}
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
					const syncing = yield* Effect.forkIn(sync(ref, ready), scope);
					yield* Effect.forkIn(release(key, syncing), scope);
				}
				return yield* encodeReply(yield* Deferred.await(ready)).pipe(Effect.orDie);
			}),
		);

		// Read from the stored snapshot, so a page and the seq it answers with always agree.
		yield* handle(
			topics.page,
			Page,
			(ref) =>
				Effect.gen(function* () {
					const { before, limit } = ref;
					const key = threadKey(ref);
					const snapshot = latest.get(key) ?? (yield* load(key));
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
						queued: snapshot.queued,
						seq: snapshot.seq,
						more: start > 0,
					};
					return yield* encodeWindow(window).pipe(Effect.orDie);
				}),
			{ ephemeral: true },
		);

		// A sent prompt wakes its thread, so its session reads as working before the run starts.
		const prompt = ({ messageId, text, delivery, ...ref }: Prompt) =>
			codework("thread.prompt", {
				...addressed(ref),
				text,
				id: messageId,
				...(delivery === undefined ? {} : { delivery }),
			}).pipe(Effect.tap(() => wake(ref.sessionId)));

		yield* handle(
			topics.activity,
			Schema.Struct({}),
			() => encodeActivity({ working: working() }).pipe(Effect.orDie),
			{ ephemeral: true },
		);

		yield* handle(topics.prompt, Prompt, (input) =>
			prompt(input).pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);

		// A folder anchors the session on the host and is where its tools run. A memory sandbox has
		// no folder to name its project after, so it is named here.
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

		// The thread's log moves with the change, so the refresh that follows publishes the new info.
		yield* handle(topics.configure, Configure, ({ model, thinkingLevel, ...ref }) =>
			codework("thread.configure", {
				...addressed(ref),
				runtime: {
					...(model === undefined ? {} : { model }),
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				},
			}).pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);

		// A cancel that lost to promotion answers `Sent`: the prompt is in the conversation, and the
		// refresh that follows the log moving shows it there.
		yield* handle(topics.cancel, Cancel, ({ messageId, ...ref }) =>
			codework("thread.cancel", { ...addressed(ref), messageId }).pipe(
				Effect.map(({ cancelled }): Cancelled => (cancelled ? { _tag: "Cancelled" } : { _tag: "Sent" })),
				Effect.catch((error) => Effect.succeed<Cancelled>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeCancelled(reply).pipe(Effect.orDie)),
			),
		);

		yield* handle(topics.change, Change, ({ messageId, delivery, text, ...ref }) =>
			codework("thread.update", {
				...addressed(ref),
				messageId,
				...(delivery === undefined ? {} : { delivery }),
				...(text === undefined ? {} : { text }),
			}).pipe(
				Effect.map(({ updated }): Reply =>
					updated ? { _tag: "Done" } : { _tag: "Failed", message: "That message was already sent." },
				),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);

		yield* handle(topics.interrupt, Interrupt, (ref) =>
			codework("thread.interrupt", addressed(ref)).pipe(
				Effect.as<Reply>({ _tag: "Done" }),
				Effect.catch((error) => Effect.succeed<Reply>({ _tag: "Failed", message: describe(error) })),
				Effect.flatMap((reply) => encodeReply(reply).pipe(Effect.orDie)),
			),
		);
	}),
});
