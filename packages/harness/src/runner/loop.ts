/*
 * @file Durable session drain.
 *
 * The loop reads queues and projections, but every durable mutation is an
 * event. LLMStarted owns the speculative draft; TurnEnded is the only commit.
 */

import { type Message } from "@codeworksh/aikit";
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect";
import { Context } from "../context/context.ts";
import { ContextCodec } from "../context/codec.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionInput } from "../session/input/input.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";
import { State } from "../state/state.ts";
import { LLMEventPublisher } from "./event.ts";
import { LLM } from "./llm.ts";
import { Runner } from "./run.ts";

export type Promotion = "steer" | "followUp" | undefined;

export interface TurnResult {
	readonly needsContinuation: boolean;
	readonly messageId?: string;
}

export interface Options {
	/** Deterministic provider seam for tests. */
	readonly request?: LLM.Request;
}

const errorMessage = <E>(cause: Cause.Cause<E>): string => {
	const squashed = Cause.squash(cause);
	if (squashed instanceof Error && squashed.message.trim().length > 0) return squashed.message;
	if (typeof squashed === "string" && squashed.trim().length > 0) return squashed;
	if (typeof squashed === "object" && squashed !== null && "_tag" in squashed) return String(squashed._tag);
	return "the turn failed for an unknown reason";
};

const terminalResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	isError: true as const,
});

const endTime = (call: Message.ToolCallPendingPart, now: number) => Math.max(call.time.end, now);

const skippedPart = (call: Message.ToolCallPendingPart, message: string, now: number): Message.ToolCallSkippedPart => ({
	...call,
	status: "skipped",
	result: terminalResult(message),
	time: { ...call.time, end: endTime(call, now) },
});

const abortedPart = (call: Message.ToolCallPendingPart, now: number): Message.ToolCallAbortedPart => ({
	...call,
	status: "aborted",
	result: terminalResult("Tool Execution Interrupted"),
	time: { ...call.time, end: endTime(call, now) },
});

const errorPart = (
	call: Message.ToolCallPendingPart,
	cause: Cause.Cause<unknown>,
	now: number,
): Message.ToolCallErrorPart => ({
	...call,
	status: "error",
	result: terminalResult(`tool execution failed: ${errorMessage(cause)}`),
	time: { ...call.time, end: endTime(call, now) },
});

export const layer = (options: Options = {}) =>
	Layer.effect(
		Runner.Service,
		Effect.gen(function* () {
			const context = yield* Context.Service;
			const events = yield* Event.Service;
			const inputs = yield* SessionInput.make;
			const sessions = yield* Session.Service;
			const state = yield* State.Service;
			const requestLLM = options.request ?? LLM.run;

			const failureStub = Effect.fn("Loop.failureStub")(function* (
				draft: Session.HydratedEntry,
				reason: "aborted" | "error",
				message: string,
			) {
				const decoded = yield* ContextCodec.decodeMessage(draft).pipe(Effect.orDie);
				if (decoded.role !== "assistant") return yield* Effect.die(`draft ${draft.entry.id} is not an assistant`);
				const completed = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return {
					...decoded,
					stopReason: reason,
					errorMessage: message,
					time: { ...decoded.time, completed },
					parts: [],
				} satisfies Message.AssistantMessage;
			});

			const publishFailure = Effect.fn("Loop.publishFailure")(function* (
				draft: Session.HydratedEntry,
				cause: EventList.TurnAbortCause,
			) {
				const reason = cause._tag === "interrupted" ? "aborted" : "error";
				const message = cause._tag === "interrupted" ? "turn interrupted before commit" : cause.message;
				yield* events.publish(EventList.LLMFailed, {
					timestamp: yield* DateTime.now,
					sessionId: draft.entry.sessionId,
					messageId: SessionMessageSchema.ID.from(draft.entry.id),
					reason,
					message: yield* failureStub(draft, reason, message),
				});
			});

			const healDanglingDraft = Effect.fn("Loop.healDanglingDraft")(function* (sessionId: SessionSchema.ID) {
				const path = yield* sessions.path(sessionId);
				const draft = path.find((entry) => entry.entry.type === "assistant" && entry.entry.state === "draft");
				if (draft === undefined) return;
				yield* publishFailure(draft, { _tag: "interrupted" });
			});

			const settleTools = Effect.fn("Loop.settleTools")(function* (
				snapshot: State.Snapshot,
				message: Message.AssistantMessage,
				reason: "stop" | "length" | "toolUse",
				markCommitted: () => void,
			) {
				const pending = message.parts.filter(
					(part): part is Message.ToolCallPendingPart => part.type === "toolCall" && part.status === "pending",
				);
				let interruptedCause: Cause.Cause<never> | undefined;
				const messageId = SessionMessageSchema.ID.from(message.messageId);

				const settle = Effect.fn("Loop.settleTool")(function* (
					call: Message.ToolCallPendingPart,
					part: Message.ToolCallTerminalPart,
				) {
					yield* events.publish(EventList.ToolSettled, {
						timestamp: yield* DateTime.now,
						sessionId: snapshot.sessionId,
						messageId,
						callID: call.callID,
						part,
					});
				});
				const commit = Effect.fn("Loop.commitTurn")(function* () {
					yield* events.publish(EventList.TurnEnded, {
						timestamp: yield* DateTime.now,
						sessionId: snapshot.sessionId,
						messageId,
					});
					markCommitted();
				});

				yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						if (reason === "length") {
							for (const call of pending) {
								const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
								yield* settle(call, skippedPart(call, "tool call arguments were truncated", now));
							}
							yield* commit();
							return;
						}

						if (reason !== "toolUse") {
							for (const call of pending) {
								const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
								yield* settle(call, skippedPart(call, "unexpected tool call for terminal response", now));
							}
							yield* commit();
							return;
						}

						const settled = new Set<string>();
						const handle = Effect.fn("Loop.handleTool")(function* (call: Message.ToolCallPendingPart) {
							yield* events.publish(EventList.ToolStarted, {
								timestamp: yield* DateTime.now,
								sessionId: snapshot.sessionId,
								messageId,
								callID: call.callID,
								name: call.name,
							});
							const handled = yield* snapshot.tools
								.handle(call, {
									onProgress: (progress) =>
										events
											.publish(EventList.ToolProgress, {
												timestamp: DateTime.makeUnsafe(progress.toolCall.time.end),
												sessionId: snapshot.sessionId,
												messageId,
												callID: call.callID,
												partial: progress.partial,
											})
											.pipe(Effect.asVoid),
								})
								.pipe(
									Effect.catchCause((cause) =>
										Cause.hasInterruptsOnly(cause)
											? Effect.interrupt
											: Effect.map(
													Effect.clockWith((clock) => clock.currentTimeMillis),
													(now) => errorPart(call, cause, now),
												),
									),
								);
							// The durable settlement and the in-memory completion marker form one
							// protected step. Otherwise an interrupt between them could make the
							// cleanup publish a second terminal transition for the same call.
							yield* Effect.uninterruptible(
								Effect.gen(function* () {
									yield* settle(call, handled);
									yield* Effect.sync(() => settled.add(call.callID));
								}),
							);
						});

						const execution = Effect.forEach(pending, handle, {
							discard: true,
							concurrency: snapshot.toolExecution === "parallel" ? "unbounded" : 1,
						});
						const exit = yield* restore(execution).pipe(Effect.exit);
						if (Exit.isFailure(exit)) {
							if (!Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
							interruptedCause = exit.cause;
							for (const call of pending) {
								if (settled.has(call.callID)) continue;
								const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
								yield* settle(call, abortedPart(call, now));
							}
						}
						yield* commit();
					}),
				);

				return interruptedCause;
			});

			const runTurnAttempt = Effect.fn("Loop.runTurnAttempt")(function* (
				promotion: Promotion,
				snapshot: State.Snapshot,
			) {
				const sessionId = snapshot.sessionId;
				if (promotion !== undefined) {
					const cutoff = yield* events.latestSequence(sessionId);
					if (promotion === "followUp") yield* inputs.promoteFollowUp(sessionId);
					yield* inputs.promoteSteers(sessionId, cutoff);
				}

				const assembled = yield* context.assemble(sessionId);
				const leaf =
					assembled.lastAssistant?.entryId === assembled.leafEntryId ? assembled.lastAssistant.message : undefined;
				if (leaf !== undefined && (leaf.stopReason === "stop" || leaf.stopReason === "length")) {
					return { needsContinuation: false } satisfies TurnResult;
				}

				let publisher: LLMEventPublisher.Publisher | undefined;
				let committed = false;
				const turnWindow = Effect.gen(function* () {
					yield* events.publish(EventList.TurnStarted, { timestamp: yield* DateTime.now, sessionId });
					publisher = yield* LLMEventPublisher.make({ sessionId }).pipe(
						Effect.provideService(Event.Service, events),
					);
					const terminal = yield* requestLLM({
						sessionId,
						context: {
							systemPrompt: snapshot.systemPrompt,
							messages: [...assembled.messages],
							tools: [...snapshot.tools.wire],
						},
						provider: snapshot.provider,
						model: snapshot.model,
						thinkingLevel: snapshot.thinkingLevel,
						options: snapshot.request,
						publisher,
					});

					if (terminal.outcome === "failed") {
						if (terminal.reason === "aborted") return yield* Effect.interrupt;
						return yield* LLM.providerError(
							{ provider: snapshot.provider, model: snapshot.model },
							LLM.messageFailure(terminal.message),
						);
					}

					const interrupted = yield* settleTools(snapshot, terminal.message, terminal.reason, () => {
						committed = true;
					});
					if (interrupted !== undefined) return yield* Effect.failCause(interrupted);
					return {
						needsContinuation: terminal.reason === "toolUse",
						messageId: terminal.message.messageId,
					} satisfies TurnResult;
				});

				return yield* turnWindow.pipe(
					Effect.catchCause((cause) => {
						if (committed) return Effect.failCause(cause);
						const turnCause: EventList.TurnAbortCause = Cause.hasInterruptsOnly(cause)
							? { _tag: "interrupted" }
							: { _tag: "error", message: errorMessage(cause) };
						const record = Effect.gen(function* () {
							if (publisher?.startedMessageId !== undefined) {
								const stored = yield* sessions.entry(publisher.startedMessageId);
								if (Option.isSome(stored) && stored.value.entry.state === "draft") {
									yield* publishFailure(stored.value, turnCause);
								}
							}
							yield* events.publish(EventList.TurnAborted, {
								timestamp: yield* DateTime.now,
								sessionId,
								cause: turnCause,
							});
						});
						return Effect.uninterruptible(record).pipe(Effect.andThen(Effect.failCause(cause)));
					}),
				);
			});

			const runTurn = Effect.fn("Loop.runTurn")(function* (promotion: Promotion, snapshot: State.Snapshot) {
				return yield* runTurnAttempt(promotion, snapshot);
			});

			const run = Effect.fn("Loop.run")(function* (input: {
				readonly sessionId: SessionSchema.ID;
				readonly force: boolean;
			}) {
				yield* healDanglingDraft(input.sessionId);

				const hasSteer = yield* inputs.hasPending(input.sessionId, "steer");
				const hasFollowUp = hasSteer ? false : yield* inputs.hasPending(input.sessionId, "followUp");
				if (!input.force && !hasSteer && !hasFollowUp) return;

				let promotion: Promotion = hasSteer ? "steer" : hasFollowUp ? "followUp" : undefined;
				let shouldRun = true;
				while (shouldRun) {
					const snapshot = yield* state.snapshot(input.sessionId);
					let needsContinuation = true;
					while (needsContinuation) {
						const result = yield* runTurn(promotion, snapshot);
						promotion = "steer";
						needsContinuation = result.needsContinuation || (yield* inputs.hasPending(input.sessionId, "steer"));
					}
					shouldRun = yield* inputs.hasPending(input.sessionId, "followUp");
					promotion = shouldRun ? "followUp" : undefined;
				}
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop.ts";
