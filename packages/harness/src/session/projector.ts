/*
 * @file Registers the durable-input projectors with the event service.
 *
 * Provides no service. Its only purpose is the registration side effect, which
 * must happen exactly once and before anything publishes -- `Layer` gives both,
 * because a layer is built once per graph, at startup.
 *
 * Registering from `SessionInput.make` instead would run once per consumer, and
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
 * definition -- any `session.llm.*` except the two terminals -- compiles, looks
 * wired, and never fires.
 *
 * Live events are not lost, they take the other path. `notify` publishes every
 * event to the typed and firehose pubsubs, so deltas and block boundaries are
 * already streaming; what does not exist yet is a `subscribe` on
 * `Event.Interface` for a consumer to read them from. That is the hook a future
 * streamer wants -- a stream it subscribes to, not a callback per event type --
 * so nothing needs registering here for it.
 */

import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer } from "effect";
import { ContextCodec } from "../context/codec.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionInput } from "./input/input.ts";
import type { SessionMessageSchema } from "./message/schema.ts";
import type { SessionSchema } from "./schema.ts";
import { Session } from "./session.ts";

export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const input = yield* SessionInput.make;
		const sessions = yield* Session.Service;

		/**
		 * One provider response becomes one assistant entry, written once, at the
		 * terminal event.
		 *
		 * Nothing is appended while a stream is in flight, so an entry can never be
		 * left mid-response by a crash -- which is what stops `Context.assemble`
		 * replaying a truncated answer to the model as though it had been finished.
		 * A hard kill instead leaves no assistant entry at all and a prompt that is
		 * still promoted, so the turn simply runs again.
		 *
		 * `Session.append` charges usage from the envelope on an assistant insert,
		 * and the terminal message is the one that carries final usage, so the
		 * existing behaviour is already the right one: charged once, never at a
		 * token boundary.
		 */
		const appendAssistant = Effect.fn("SessionProjector.appendAssistant")(function* (input: {
			readonly sessionId: SessionSchema.ID;
			readonly messageId: SessionMessageSchema.ID;
			readonly message: Message.AssistantMessage;
			readonly seq: number;
			readonly metadata?: Record<string, string>;
		}) {
			// Two fields that could disagree: the event names the message it is about,
			// and the message names itself. The codec requires the entry id to equal
			// the message id, so a disagreement here would silently store the entry
			// under one id while its envelope claims another.
			if (input.message.messageId !== input.messageId) {
				return yield* Effect.die(
					`assistant message id "${input.message.messageId}" does not match event message id "${input.messageId}"`,
				);
			}
			const encoded = yield* ContextCodec.encodeMessage(input.message).pipe(Effect.orDie);
			yield* sessions
				.append({
					id: input.messageId,
					sessionId: input.sessionId,
					seq: input.seq,
					...encoded,
					...(input.metadata === undefined ? {} : { metadata: input.metadata }),
				})
				.pipe(Effect.orDie);
		});

		yield* events.project(EventList.PromptAdmitted, (event) =>
			Effect.gen(function* () {
				// The sequence is assigned by the commit itself, so a durable event
				// arriving without one means it never went through the transaction.
				if (event.durable === undefined)
					return yield* Effect.die("PromptAdmitted is missing its aggregate sequence");
				yield* input.projectAdmitted({
					admittedSeq: event.durable.seq,
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					prompt: event.data.prompt,
					delivery: event.data.delivery,
					timeCreated: event.data.timestamp,
				});
			}),
		);

		// Publishing `Prompted` is what promotes an input, so this registration is
		// what makes `promoteSteers` / `promoteFollowUp` take effect at all.
		yield* events.project(EventList.Prompted, (event) =>
			Effect.gen(function* () {
				if (event.durable === undefined) return yield* Effect.die("Prompted is missing its aggregate sequence");
				yield* input.projectPrompted({
					promotedSeq: event.durable.seq,
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					prompt: event.data.prompt,
					delivery: event.data.delivery,
					timeCreated: event.data.timestamp,
				});
				// Promotion is what puts a prompt into the conversation, so the append
				// belongs in this commit: "promoted but absent from history" is then
				// unrepresentable rather than a window someone has to reconcile.
				// Materialize the canonical conversation message now. Context later
				// rehydrates this envelope + parts; aikit performs only the target-model
				// conversion when Loop calls the provider.
				const encoded = yield* ContextCodec.encodeMessage(
					Message.createUserMessage({
						messageId: event.data.messageId,
						role: "user",
						time: { created: DateTime.toEpochMillis(event.data.timestamp) },
						parts: [{ type: "text", text: event.data.prompt.text }],
					}),
				).pipe(Effect.orDie);
				yield* sessions
					.append({
						id: event.data.messageId,
						sessionId: event.data.sessionId,
						seq: event.durable.seq,
						...encoded,
						// Rides the in-memory payload; the event row never carried it, so
						// the entry is the only place it can outlive the publish.
						...(event.metadata === undefined ? {} : { metadata: event.metadata }),
					})
					.pipe(Effect.orDie);
			}),
		);

		yield* events.project(EventList.LLMEnded, (event) =>
			Effect.gen(function* () {
				if (event.durable === undefined) return yield* Effect.die("LLMEnded is missing its aggregate sequence");
				yield* appendAssistant({
					sessionId: event.data.sessionId,
					messageId: event.data.messageId,
					message: event.data.message,
					seq: event.durable.seq,
					...(event.metadata === undefined ? {} : { metadata: event.metadata }),
				});
			}),
		);

		/*
		 * A failed response is stored exactly like a successful one. aikit names the
		 * payload `error`, but it is a complete assistant message carrying whatever
		 * was generated before the failure -- its `stopReason` and `errorMessage` are
		 * what record that it failed, not its absence from the conversation. An
		 * aborted turn therefore keeps the text the model had already produced, which
		 * is what both reference implementations do.
		 */
		yield* events.project(EventList.LLMFailed, (event) =>
			Effect.gen(function* () {
				if (event.durable === undefined) return yield* Effect.die("LLMFailed is missing its aggregate sequence");
				yield* appendAssistant({
					sessionId: event.data.sessionId,
					messageId: event.data.messageId,
					message: event.data.message,
					seq: event.durable.seq,
					...(event.metadata === undefined ? {} : { metadata: event.metadata }),
				});
			}),
		);
	}),
);

export * as SessionProjector from "./projector.ts";
