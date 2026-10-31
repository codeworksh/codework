/*
 * @file Registers the durable-input projectors with the event service.
 *
 * Provides no service. Its only purpose is the registration side effect, which
 * must happen exactly once and before anything publishes -- `Layer` gives both,
 * because a layer is built once per graph, at startup.
 *
 * Registering from `Inbox.make` instead would run once per consumer, and
 * a projector registered twice runs twice on one event: the second insert hits
 * ON CONFLICT, raises LifecycleConflict inside the commit, and rolls the event
 * back. Every admission would fail, blaming a conflict that does not exist.
 *
 * Nothing type-errors if this layer is left out of the graph. `admit` publishes
 * happily and writes no row, so the wiring is worth asserting in a test.
 *
 * Only durable definitions are registered here, and that is not a stylistic
 * choice: `Event.project` hands its callback to `commitDurableEvent`, which only
 * runs for events that have a transaction. Registering a projector for a live
 * definition -- TurnStarted/TurnAborted, LLM fragments, or tool progress --
 * compiles, looks wired, and never fires.
 *
 * Live events are not lost, they take the other path. `notify` publishes every
 * event to the typed and firehose pubsubs, so deltas and block boundaries are
 * already streaming; what does not exist yet is a `subscribe` on
 * `Event.Interface` for a consumer to read them from. That is the hook a future
 * streamer wants -- a stream it subscribes to, not a callback per event type --
 * so nothing needs registering here for it.
 */

import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { ContextCodec } from "../context/codec.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { Document } from "../document/document.ts";
import { Inbox } from "../inbox/inbox.ts";
import { TOOL_SEARCH_NAME, ToolSearchDetails } from "../plugin/builtin/tool/toolsearch.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
import { PromptSchema } from "./prompt/schema.ts";
import type { SessionMessageSchema } from "./message/schema.ts";
import { SessionSchema } from "./schema.ts";
import { Session } from "./session.ts";

const decodeLoaded = Schema.decodeUnknownOption(ToolSearchDetails);
const encodeSystemData = Schema.encodeEffect(SessionSchema.SystemData);

export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const input = yield* Inbox.make;
		const sessions = yield* Session.Service;
		const threads = yield* Thread.Service;
		const documents = yield* Document.Service;

		/** The sequence is assigned by the commit itself, so a durable event without one never went through it. */
		const seqOf = (event: { readonly type: string; readonly durable?: { readonly seq: number } }) =>
			event.durable === undefined
				? Effect.die(`${event.type} is missing its aggregate sequence`)
				: Effect.succeed(event.durable.seq);

		const encodeAssistant = Effect.fn("SessionProjector.encodeAssistant")(function* (input: {
			readonly messageId: SessionMessageSchema.ID;
			readonly message: Message.AssistantMessage;
		}) {
			if (input.message.messageId !== input.messageId) {
				return yield* Effect.die(
					`assistant message id "${input.message.messageId}" does not match event message id "${input.messageId}"`,
				);
			}
			return yield* ContextCodec.encodeMessage(input.message).pipe(Effect.orDie);
		});

		yield* events.project(EventList.SessionCreated, (event) =>
			seqOf(event).pipe(Effect.flatMap((seq) => sessions.projectCreated(event.data, seq))),
		);

		yield* events.project(EventList.ThreadForked, (event) =>
			seqOf(event).pipe(Effect.flatMap((seq) => threads.projectForked(event.data, seq))),
		);

		yield* events.project(EventList.ThreadConfigured, (event) =>
			seqOf(event).pipe(Effect.flatMap((seq) => documents.configure(event.data.threadId, event.data.change, seq))),
		);

		yield* events.project(EventList.PromptAdmitted, (event) =>
			Effect.gen(function* () {
				yield* input.projectAdmitted({
					admittedSeq: yield* seqOf(event),
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					threadId: event.data.threadId,
					prompt: event.data.prompt,
					delivery: event.data.delivery,
					timeCreated: event.data.timestamp,
				});
			}),
		);

		yield* events.project(EventList.PromptCancelled, (event) =>
			Effect.gen(function* () {
				yield* input.projectCancelled({
					cancelledSeq: yield* seqOf(event),
					id: event.data.messageId,
					threadId: event.data.threadId,
				});
			}),
		);

		yield* events.project(EventList.PromptUpdated, (event) =>
			input.projectUpdated({
				id: event.data.messageId,
				threadId: event.data.threadId,
				...(event.data.prompt === undefined ? {} : { prompt: event.data.prompt }),
				...(event.data.delivery === undefined ? {} : { delivery: event.data.delivery }),
			}),
		);

		// Publishing `Prompted` is what promotes an input, so this registration is
		// what makes `promoteSteers` / `promoteFollowUp` take effect at all.
		yield* events.project(EventList.Prompted, (event) =>
			Effect.gen(function* () {
				const seq = yield* seqOf(event);
				yield* input.projectPrompted({
					promotedSeq: seq,
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					threadId: event.data.threadId,
					prompt: event.data.prompt,
					delivery: event.data.delivery,
					timeCreated: event.data.timestamp,
				});
				// Promotion is what puts a prompt into the conversation, so the append
				// belongs in this commit: "promoted but absent from history" is then
				// unrepresentable rather than a window someone has to reconcile.
				const encoded = yield* ContextCodec.encodeMessage(
					Message.createUserMessage({
						messageId: event.data.messageId,
						role: "user",
						time: { created: DateTime.toEpochMillis(event.data.timestamp) },
						parts: [...event.data.prompt.parts],
					}),
				).pipe(Effect.orDie);
				yield* threads
					.append({
						id: event.data.messageId,
						threadId: event.data.threadId,
						seq,
						state: "committed",
						...encoded,
						// Rides the in-memory payload; the event row never carried it, so
						// the entry is the only place it can outlive the publish.
						...(event.metadata === undefined ? {} : { metadata: event.metadata }),
					})
					.pipe(Effect.orDie);
				const title = ThreadSchema.titleFrom(PromptSchema.Prompt.text(event.data.prompt));
				if (title !== undefined) yield* threads.retitle(event.data.threadId, title);
			}),
		);

		yield* events.project(EventList.LLMStarted, (event) =>
			Effect.gen(function* () {
				const encoded = yield* encodeAssistant(event.data);
				yield* threads
					.append({
						id: event.data.messageId,
						threadId: event.data.threadId,
						seq: yield* seqOf(event),
						state: "draft",
						...encoded,
						...(event.metadata === undefined ? {} : { metadata: event.metadata }),
					})
					.pipe(Effect.orDie);
			}),
		);

		yield* events.project(EventList.LLMEnded, (event) =>
			Effect.gen(function* () {
				const encoded = yield* encodeAssistant(event.data);
				yield* threads.replaceAssistant({
					id: event.data.messageId,
					threadId: event.data.threadId,
					data: encoded.data,
					parts: encoded.parts,
				});
			}),
		);

		yield* events.project(EventList.LLMFailed, (event) =>
			Effect.gen(function* () {
				const encoded = yield* encodeAssistant(event.data);
				yield* threads.abort({
					id: event.data.messageId,
					threadId: event.data.threadId,
					seq: yield* seqOf(event),
					data: encoded.data,
				});
			}),
		);

		yield* events.project(EventList.SystemChanged, (event) =>
			Effect.gen(function* () {
				const { sections, toolsAdded, toolsRemoved, hash } = event.data;
				yield* threads
					.append({
						id: event.data.messageId,
						threadId: event.data.threadId,
						seq: yield* seqOf(event),
						type: "system",
						data: yield* encodeSystemData({
							...(sections === undefined ? {} : { sections }),
							toolsAdded,
							toolsRemoved,
							hash,
						}).pipe(Effect.orDie),
					})
					.pipe(Effect.orDie);
			}),
		);

		yield* events.project(EventList.ToolSettled, (event) =>
			Effect.gen(function* () {
				const { part, threadId } = event.data;
				const encoded = yield* ContextCodec.encodePart(part).pipe(Effect.orDie);
				yield* threads.settleToolCall({
					entryId: event.data.messageId,
					callId: event.data.callID,
					status: part.status,
					data: encoded.data,
				});
				// Written here, not by a second event: a load is a fact of the settled call, so its `agent`
				// revision lands at the settle's own seq and can never be split from it.
				const loaded =
					part.name === TOOL_SEARCH_NAME && part.status === "completed"
						? decodeLoaded(part.result.details)
						: Option.none();
				if (Option.isNone(loaded) || loaded.value.loaded.length === 0) return;
				const names = loaded.value.loaded;
				const current = (yield* documents.agent(threadId)).modelTools;
				const remove = (current?.remove ?? []).filter((name) => !names.includes(name));
				const add = [...(current?.add ?? [])];
				for (const name of names) if (!add.includes(name)) add.push(name);
				yield* documents.configure(
					threadId,
					{ modelTools: { ...(remove.length === 0 ? {} : { remove }), add } },
					yield* seqOf(event),
				);
			}),
		);

		yield* events.project(EventList.TurnEnded, (event) =>
			Effect.gen(function* () {
				yield* threads.commit({
					id: event.data.messageId,
					threadId: event.data.threadId,
					seq: yield* seqOf(event),
				});
				yield* threads.resetRestarts(event.data.threadId);
			}),
		);
	}),
);

export * as SessionProjector from "./projector.ts";
