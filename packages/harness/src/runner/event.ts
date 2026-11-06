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
 * lifecycle events reach `entry` through the projectors in
 * `session/projector.ts`.
 *
 * There are no fragment buffers here, which is the main structural difference
 * from the reference implementation this file is named after. Its provider
 * events carry only fragments, so it has to reassemble text across deltas before
 * it can persist a block. Every aikit event already carries a complete assistant
 * message, and the terminal one carries the whole response. Successful output
 * can therefore replace the draft in one write, and failed output keeps the
 * latest partial without needing a fragment buffer. While streaming, that
 * partial is checkpointed into the draft (`LLMProgress`) so a dead host leaves it.
 */

import type { Event as AikitEvent, Message } from "@codeworksh/aikit";
import { DateTime, Duration, Effect, Fiber, Option, Schema } from "effect";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { EventSchema } from "../event/schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { SessionSchema } from "../session/schema.ts";
import type { ThreadSchema } from "../thread/schema.ts";
import { RunnerPart } from "./part.ts";
import { Runner } from "./run.ts";

type Part = Message.AssistantMessage["parts"][number];

const CHECKPOINT_INTERVAL = Duration.seconds(1);

const decodePartial = Schema.decodeUnknownEffect(EventSchema.AikitAssistantMessage);

const textOf = (part: Part) =>
	part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined;
const withoutText = (part: Part): Part =>
	part.type === "text" ? { ...part, text: "" } : part.type === "thinking" ? { ...part, thinking: "" } : part;

/** What `after` changed since `before`: grown text appends, every other difference writes the part whole. */
const changesSince = (before: ReadonlyArray<Part>, after: ReadonlyArray<Part>) => {
	const changes: Array<EventList.LLMProgressChange> = [];
	for (const [partIndex, part] of after.entries()) {
		const previous = before[partIndex];
		const was = previous === undefined ? undefined : textOf(previous);
		const now = textOf(part);
		if (
			previous !== undefined &&
			was !== undefined &&
			now !== undefined &&
			now.startsWith(was) &&
			JSON.stringify(withoutText(previous)) === JSON.stringify(withoutText(part))
		) {
			if (now.length > was.length) changes.push({ _tag: "append", partIndex, text: now.slice(was.length) });
			continue;
		}
		if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(part)) {
			changes.push({ _tag: "set", partIndex, part });
		}
	}
	return changes;
};

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
	/** A copy of the latest streamed message until the response settles: what a failure it did not report keeps. */
	readonly partial: Message.AssistantMessage | undefined;
	/** Ends checkpointing, waiting out one in flight: no checkpoint lands after this returns. */
	readonly stop: Effect.Effect<void>;
	/** Interpret one provider event. Durable ones commit before this returns. */
	readonly publish: (event: AikitEvent.LLMMessageEvent) => Effect.Effect<void, Runner.LLMStreamError>;
	/** How the response settled; fails if the stream ended without terminating. */
	readonly terminal: Effect.Effect<Terminal, Runner.LLMStreamError>;
}

export const make = Effect.fn("LLMEventPublisher.make")(function* (input: {
	readonly sessionId: SessionSchema.ID;
	readonly threadId: ThreadSchema.ID;
}) {
	const events = yield* Event.Service;

	let messageId: SessionMessageSchema.ID | undefined;
	let startedMessageId: SessionMessageSchema.ID | undefined;
	let settled: Terminal | undefined;
	const clone = (message: Message.AssistantMessage): Message.AssistantMessage => structuredClone(message);

	// aikit rewrites one partial object in place, so this is a live view: copied when read.
	let latest: Message.AssistantMessage | undefined;
	let checkpointed: ReadonlyArray<Part> = [];
	let dirty = false;
	let stopped = false;
	let ticker: Fiber.Fiber<void> | undefined;

	// Each part's text length so far, counted from the deltas: `partial` may have moved on when read.
	const lengths = new Map<number, number>();
	const advance = (partIndex: number, delta: string) => {
		const offset = lengths.get(partIndex) ?? 0;
		lengths.set(partIndex, offset + delta.length);
		return offset;
	};

	const checkpoint = Effect.gen(function* () {
		dirty = false;
		if (latest === undefined || startedMessageId === undefined) return;
		// A partial mid-way through a part may not be a valid message yet; the next checkpoint takes it.
		const decoded = yield* decodePartial(clone(latest)).pipe(Effect.option);
		if (Option.isNone(decoded)) return;
		const parts = decoded.value.parts;
		const changes = changesSince(checkpointed, parts);
		if (changes.length === 0) return;
		yield* events.publish(EventList.LLMProgress, {
			sessionId: input.sessionId,
			threadId: input.threadId,
			timestamp: yield* DateTime.now,
			messageId: startedMessageId,
			changes,
		});
		checkpointed = parts;
	});

	// One checkpoint a second at most, one in flight; the ticker ends once a checkpoint finds nothing new.
	const tick = Effect.gen(function* () {
		while (true) {
			yield* Effect.sleep(CHECKPOINT_INTERVAL);
			yield* Effect.uninterruptible(checkpoint);
			// Cleared with the decision, no yield between: an `observe` after it forks a fresh ticker.
			if (!dirty) {
				ticker = undefined;
				return;
			}
		}
	}).pipe(
		// Not `ensuring`: after a normal exit `ticker` may already be the fresh one.
		Effect.onError(() =>
			Effect.sync(() => {
				ticker = undefined;
			}),
		),
	);

	const observe = (partial: Message.AssistantMessage) =>
		Effect.suspend(() => {
			// A partial without content, such as the opening one, shows nothing worth keeping.
			if (stopped || partial.parts.length === 0) return Effect.void;
			latest = partial;
			dirty = true;
			if (ticker !== undefined) return Effect.void;
			return Effect.map(Effect.forkDetach(tick), (fiber) => {
				ticker = fiber;
			});
		});

	const stop = Effect.suspend(() => {
		stopped = true;
		return ticker === undefined ? Effect.void : Fiber.interrupt(ticker);
	});

	const fault = (reason: string) => new Runner.LLMStreamError({ threadId: input.threadId, reason });

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
			const base = { sessionId: input.sessionId, threadId: input.threadId, timestamp };
			if (
				event.type !== "start" &&
				event.type !== "done" &&
				event.type !== "error" &&
				event.partial.messageId === startedMessageId
			) {
				yield* observe(event.partial);
			}

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
				 * block; what a crash would lose is kept by the throttled checkpoints of
				 * the draft instead, which stays out of the model's context.
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
						offset: advance(event.partIndex, event.delta),
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
						offset: advance(event.partIndex, event.delta),
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
					yield* stop;
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
				 * message, with whatever streamed before the failure. LLMFailed keeps it
				 * as the aborted entry; a tool call in it never runs.
				 */
				case "error": {
					const message = RunnerPart.abortCalls(clone(event.error), DateTime.toEpochMillis(timestamp));
					const identified = yield* identify(message.messageId);
					yield* stop;
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
		get partial() {
			return settled !== undefined || latest === undefined ? undefined : clone(latest);
		},
		stop,
		publish,
		terminal,
	} satisfies Publisher;
});

export * as LLMEventPublisher from "./event.ts";
