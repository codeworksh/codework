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
import { DateTime, Effect, Layer, Schema } from "effect";
import { ContextCodec } from "../context/codec.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionInput } from "./input/input.ts";
import type { SessionMessageSchema } from "./message/schema.ts";
import type { SessionSchema } from "./schema.ts";
import { Session } from "./session.ts";
import { optional } from "../schema.ts";

const ConfigChangeData = Schema.fromJsonString(
	Schema.Struct({
		model: optional(Schema.Struct({ providerId: Schema.String, modelId: Schema.String })),
		thinkingLevel: optional(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
	}),
);
const encodeConfigChange = Schema.encodeEffect(ConfigChangeData);

export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const input = yield* SessionInput.make;
		const sessions = yield* Session.Service;

		yield* events.project(EventList.ConfigChanged, (event) =>
			Effect.gen(function* () {
				if (event.durable === undefined)
					return yield* Effect.die("ConfigChanged is missing its aggregate sequence");
				yield* sessions
					.append({
						id: event.id,
						sessionId: event.data.sessionId,
						seq: event.durable.seq,
						type: "configChange",
						state: "committed",
						data: yield* encodeConfigChange({
							...(event.data.model === undefined ? {} : { model: event.data.model }),
							...(event.data.thinkingLevel === undefined ? {} : { thinkingLevel: event.data.thinkingLevel }),
						}).pipe(Effect.orDie),
					})
					.pipe(Effect.orDie);
			}),
		);

		const encodeAssistant = Effect.fn("SessionProjector.encodeAssistant")(function* (input: {
			readonly sessionId: SessionSchema.ID;
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
						state: "committed",
						...encoded,
						// Rides the in-memory payload; the event row never carried it, so
						// the entry is the only place it can outlive the publish.
						...(event.metadata === undefined ? {} : { metadata: event.metadata }),
					})
					.pipe(Effect.orDie);
			}),
		);

		yield* events.project(EventList.LLMStarted, (event) =>
			Effect.gen(function* () {
				if (event.durable === undefined) return yield* Effect.die("LLMStarted is missing its aggregate sequence");
				const encoded = yield* encodeAssistant({
					sessionId: event.data.sessionId,
					messageId: event.data.messageId,
					message: event.data.message,
				});
				yield* sessions
					.append({
						id: event.data.messageId,
						sessionId: event.data.sessionId,
						seq: event.durable.seq,
						state: "draft",
						...encoded,
						...(event.metadata === undefined ? {} : { metadata: event.metadata }),
					})
					.pipe(Effect.orDie);
			}),
		);

		yield* events.project(EventList.LLMEnded, (event) =>
			Effect.gen(function* () {
				const encoded = yield* encodeAssistant({
					sessionId: event.data.sessionId,
					messageId: event.data.messageId,
					message: event.data.message,
				});
				yield* sessions.replaceAssistant({
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					data: encoded.data,
					parts: encoded.parts,
				});
			}),
		);

		yield* events.project(EventList.LLMFailed, (event) =>
			Effect.gen(function* () {
				const encoded = yield* encodeAssistant({
					sessionId: event.data.sessionId,
					messageId: event.data.messageId,
					message: event.data.message,
				});
				yield* sessions.abortAssistant({
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					data: encoded.data,
				});
			}),
		);

		yield* events.project(EventList.ToolSettled, (event) =>
			Effect.gen(function* () {
				const encoded = yield* ContextCodec.encodePart(event.data.part).pipe(Effect.orDie);
				yield* sessions.settleToolCall({
					entryId: event.data.messageId,
					callId: event.data.callID,
					status: event.data.part.status,
					data: encoded.data,
				});
			}),
		);

		yield* events.project(EventList.TurnEnded, (event) =>
			sessions.setEntryState({
				id: event.data.messageId,
				sessionId: event.data.sessionId,
				state: "committed",
			}),
		);
	}),
);

export * as SessionProjector from "./projector.ts";
