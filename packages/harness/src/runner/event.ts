/*
 * @file Translates one aikit provider stream into Harness events.
 *
 * Request-scoped by construction: `make` is an Effect, not a `Layer` or a
 * `Context.Service`. Those are graph-lifetime, so a service here would share one
 * request's latches with every other request on the process. Every
 * `yield* make(...)` allocates its own.
 *
 * The LLM boundary sequences the stream and hands each event over; this
 * module decides what the event means. It writes nothing itself -- the two
 * durable events reach `session_entry` through the projectors in
 * `session/projector.ts`.
 *
 * There are no fragment buffers here, which is the main structural difference
 * from the reference implementation this file is named after. Its provider
 * events carry only fragments, so it has to reassemble text across deltas before
 * it can persist a block. Every aikit event already carries a complete assistant
 * message, and the terminal one carries the whole response -- including whatever
 * was generated before an abort -- so there is nothing to reassemble and nothing
 * to flush.
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
	/** Interpret one provider event. Durable ones commit before this returns. */
	readonly publish: (event: AikitEvent.LLMMessageEvent) => Effect.Effect<void, Runner.LLMStreamError>;
	/** How the response settled; fails if the stream ended without terminating. */
	readonly terminal: Effect.Effect<Terminal, Runner.LLMStreamError>;
}

export const make = Effect.fn("LLMEventPublisher.make")(function* (input: { readonly sessionId: SessionSchema.ID }) {
	const events = yield* Event.Service;

	let messageId: SessionMessageSchema.ID | undefined;
	let settled: Terminal | undefined;

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
					yield* events.publish(EventList.LLMStarted, {
						...base,
						messageId: yield* identify(event.partial.messageId),
					});
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
				 * Out of scope for this phase, and unreachable in practice: the loop
				 * registers no tools, so a provider has nothing to call. Logged rather
				 * than failed because a stray tool event is the provider misbehaving,
				 * not a reason to lose the response -- the terminal message still
				 * carries the call, and the durable projection stores it verbatim.
				 */
				case "toolcall.start":
				case "toolcall.delta":
				case "toolcall.end":
				case "toolcall.final": {
					yield* Effect.logWarning("llm: tool-call event with no tools registered").pipe(
						Effect.annotateLogs({ sessionId: input.sessionId, type: event.type, partIndex: event.partIndex }),
					);
					return;
				}

				case "done": {
					yield* events.publish(EventList.LLMEnded, {
						...base,
						messageId: yield* identify(event.message.messageId),
						reason: event.reason,
						message: event.message,
					});
					// Latched after the commit, so it records what is durable rather than
					// what was attempted.
					settled = { outcome: "ended", reason: event.reason, message: event.message };
					return;
				}

				/*
				 * aikit calls the payload `error`, but it is a complete assistant
				 * message: an abort arrives here carrying every block produced before
				 * the interrupt. Publishing it is what keeps that work, so the durable
				 * path for a failure is the same one a success takes.
				 */
				case "error": {
					yield* events.publish(EventList.LLMFailed, {
						...base,
						messageId: yield* identify(event.error.messageId),
						reason: event.reason,
						message: event.error,
					});
					settled = { outcome: "failed", reason: event.reason, message: event.error };
					return;
				}
			}
		});

	const terminal: Effect.Effect<Terminal, Runner.LLMStreamError> = Effect.suspend(() =>
		settled === undefined
			? Effect.fail(fault("the provider stream ended without a terminal event"))
			: Effect.succeed(settled),
	);

	return { publish, terminal } satisfies Publisher;
});

export * as LLMEventPublisher from "./event.ts";
