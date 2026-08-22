/*
 * @file Translates one aikit provider stream into Harness events.
 *
 * Request-scoped by construction: `make` is an Effect, not a `Layer` or a
 * `Context.Service`. Those are graph-lifetime, so a service here would share one
 * request's latches with every other request on the process. Every
 * `yield* make(...)` allocates its own.
 *
 * The LLM boundary sequences the stream and hands each event over; this
 * module decides what the event means. It writes nothing itself -- durable
 * lifecycle events reach `session_entry` through the projectors in
 * `session/projector.ts`.
 *
 * There are no fragment buffers here, which is the main structural difference
 * from the reference implementation this file is named after. Its provider
 * events carry only fragments, so it has to reassemble text across deltas before
 * it can persist a block. Every aikit event already carries a complete assistant
 * message, and the terminal one carries the whole response. Successful output
 * can therefore replace the draft in one write; failed output becomes a
 * partless tombstone without needing a fragment buffer.
 */

import type { Event as AikitEvent, Message } from "@codeworksh/aikit";
import { DateTime, Effect } from "effect";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { SessionSchema } from "../session/schema.ts";
import { Runner } from "./run.ts";

/** How the response settled. The loop branches on this, never on `result()`. */
export type Terminal =
	| {
			readonly outcome: "ended";
			readonly reason: "stop" | "length" | "toolUse";
			readonly message: Message.AssistantMessage;
	  }
	| {
			readonly outcome: "failed";
			readonly reason: "aborted" | "error";
			readonly message: Message.AssistantMessage;
	  };

export interface Publisher {
	/** Set only after LLMStarted committed its draft row. */
	readonly startedMessageId: SessionMessageSchema.ID | undefined;
	/** Interpret one provider event. Durable ones commit before this returns. */
	readonly publish: (event: AikitEvent.LLMMessageEvent) => Effect.Effect<void, Runner.LLMStreamError>;
	/** How the response settled; fails if the stream ended without terminating. */
	readonly terminal: Effect.Effect<Terminal, Runner.LLMStreamError>;
}

export const make = Effect.fn("LLMEventPublisher.make")(function* (input: { readonly sessionId: SessionSchema.ID }) {
	const events = yield* Event.Service;

	let messageId: SessionMessageSchema.ID | undefined;
	let startedMessageId: SessionMessageSchema.ID | undefined;
	let settled: Terminal | undefined;
	const clone = (message: Message.AssistantMessage): Message.AssistantMessage => structuredClone(message);

	const fault = (reason: string) => new Runner.LLMStreamError({ sessionId: input.sessionId, reason });

	/**
	 * Every event names the message it belongs to. The first one to arrive fixes
	 * the identity for the whole response; a later disagreement means two
	 * responses are interleaving on one stream, which would silently file half of
	 * one under the other.
	 *
	 * Reading `messageId` off `partial` is safe even though `partial` itself is
	 * not: aikit mutates that object in place as the stream advances, but the id
	 * is fixed when the message is created and never moves.
	 */
	const identify = (observed: string) =>
		Effect.suspend(() => {
			const id = SessionMessageSchema.ID.from(observed);
			if (messageId === undefined) {
				messageId = id;
				return Effect.succeed(id);
			}
			return messageId === id
				? Effect.succeed(messageId)
				: Effect.fail(fault(`message id changed mid-response: "${messageId}" then "${id}"`));
		});

	const publish = (event: AikitEvent.LLMMessageEvent): Effect.Effect<void, Runner.LLMStreamError> =>
		Effect.gen(function* () {
			// Exactly one terminal per response. A second, or anything after one,
			// would append a second assistant entry for the same request.
			if (settled !== undefined) {
				return yield* fault(`received "${event.type}" after the response had already terminated`);
			}
			const timestamp = yield* DateTime.now;
			const base = { sessionId: input.sessionId, timestamp };

			switch (event.type) {
				case "start": {
					if (startedMessageId !== undefined) return yield* fault("received a second start event");
					const message = clone(event.partial);
					const identified = yield* identify(message.messageId);
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							yield* events.publish(EventList.LLMStarted, {
								...base,
								messageId: identified,
								message,
							});
							startedMessageId = identified;
						}),
					);
					return;
				}

				/*
				 * Live only, all of them. The terminal message contains every finished
				 * block, so persisting these would write the same text twice and, worse,
				 * leave an entry that a crash could strand mid-response -- which
				 * `Context.assemble` would then replay to the model as a complete turn.
				 *
				 * Only scalars computed at push time are carried. `partial` is excluded
				 * deliberately: it is one object aikit rewrites in place and pushes by
				 * reference into a queue, so by the time this consumer reads a queued
				 * event the value has already moved on.
				 */
				case "text.start": {
					yield* events.publish(EventList.LLMTextStart, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
					});
					return;
				}
				case "text.delta": {
					yield* events.publish(EventList.LLMTextDelta, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
						delta: event.delta,
					});
					return;
				}
				case "text.end": {
					yield* events.publish(EventList.LLMTextEnd, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
						content: event.content,
					});
					return;
				}
				case "thinking.start": {
					yield* events.publish(EventList.LLMThinkingStart, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
					});
					return;
				}
				case "thinking.delta": {
					yield* events.publish(EventList.LLMThinkingDelta, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
						delta: event.delta,
					});
					return;
				}
				case "thinking.end": {
					yield* events.publish(EventList.LLMThinkingEnd, {
						...base,
						messageId: yield* identify(event.partial.messageId),
						partIndex: event.partIndex,
						content: event.content,
					});
					return;
				}

				/*
				 * Tool stream fragments stay live-only. The authoritative pending calls
				 * arrive in the terminal assistant and are persisted by LLMEnded.
				 */
				case "toolcall.start":
				case "toolcall.delta":
				case "toolcall.end":
				case "toolcall.final": {
					return;
				}

				case "done": {
					if (startedMessageId === undefined) return yield* fault("received done before start");
					const message = clone(event.message);
					const identified = yield* identify(message.messageId);
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							yield* events.publish(EventList.LLMEnded, {
								...base,
								messageId: identified,
								reason: event.reason,
								message,
							});
							// Latched after the commit, so it records what is durable rather than
							// what was attempted.
							settled = { outcome: "ended", reason: event.reason, message };
						}),
					);
					return;
				}

				/*
				 * aikit calls the payload `error`, but it is a complete assistant
				 * message. LLMFailed uses its envelope as an aborted tombstone and the
				 * projector deliberately discards every partial part.
				 */
				case "error": {
					const message = clone(event.error);
					const identified = yield* identify(message.messageId);
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							if (startedMessageId !== undefined) {
								yield* events.publish(EventList.LLMFailed, {
									...base,
									messageId: identified,
									reason: event.reason,
									message,
								});
							}
							settled = { outcome: "failed", reason: event.reason, message };
						}),
					);
					return;
				}
			}
		});

	const terminal: Effect.Effect<Terminal, Runner.LLMStreamError> = Effect.suspend(() =>
		settled === undefined
			? Effect.fail(fault("the provider stream ended without a terminal event"))
			: Effect.succeed(settled),
	);

	return {
		get startedMessageId() {
			return startedMessageId;
		},
		publish,
		terminal,
	} satisfies Publisher;
});

export * as LLMEventPublisher from "./event.ts";
