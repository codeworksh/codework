/*
 * @file Durable session drain.
 *
 * The loop reads queues and projections, but every durable mutation is an
 * event. LLMStarted owns the speculative draft; TurnEnded is the only commit.
 */

import { type Message } from "@codeworksh/aikit";
import { Cause, DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { ContextCodec } from "../context/codec.ts";
import { Context } from "../context/context.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionInput } from "../session/input/input.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";
import { State } from "../state/state.ts";
import { errorMessage } from "../util/error.ts";
import { LLMEventPublisher } from "./event.ts";
import { LLM } from "./llm.ts";
import { Retry } from "./retry.ts";
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
								label: snapshot.tools.defs.find((def) => def.name === call.name)?.label,
								arguments: call.arguments,
							});
							const handled = yield* snapshot.tools
								.handle(call, {
									sessionId: snapshot.sessionId,
									messageId,
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
									Effect.catchCauseIf(
										(cause) => !Cause.hasInterrupts(cause),
										(cause) =>
											Effect.map(
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
							if (!Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
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

				// The latest attempt's publisher; a retried turn has one per provider request.
				let publisher: LLMEventPublisher.Publisher | undefined;
				let committed = false;
				let retries = 0;

				/** Abort the latest attempt's draft, unless its own terminal event already did. */
				const settleDraft = (cause: EventList.TurnAbortCause) =>
					Effect.gen(function* () {
						if (publisher?.startedMessageId === undefined) return;
						const stored = yield* sessions.entry(publisher.startedMessageId);
						if (Option.isSome(stored) && stored.value.entry.state === "draft") {
							yield* publishFailure(stored.value, cause);
						}
					});

				const attempt = Effect.gen(function* () {
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
						resolvedModel: snapshot.resolvedModel,
						thinkingLevel: snapshot.thinkingLevel,
						options: snapshot.request,
						settings: snapshot.settings,
						publisher,
					});

					if (terminal.outcome === "failed") {
						if (terminal.reason === "aborted") return yield* Effect.interrupt;
						return yield* LLM.providerError(
							{ provider: snapshot.provider, model: snapshot.model },
							LLM.messageFailure(terminal.message),
						);
					}
					return terminal;
				});

				/*
				 * Nothing is committed before TurnEnded, so a failed request can always be repeated
				 * against the same assembled context. Each failed attempt keeps its aborted draft in
				 * the journal and the next one starts a new draft. An interrupt during the backoff
				 * finds no open draft: the failed one was settled before the sleep.
				 */
				const request = (): Effect.Effect<
					Effect.Success<typeof attempt>,
					Effect.Error<typeof attempt>,
					Effect.Services<typeof attempt>
				> =>
					attempt.pipe(
						Effect.catch((error) => {
							const delayMs = Retry.delay(snapshot.retry, retries + 1, error);
							if (delayMs === undefined) return Effect.fail(error);
							return Effect.gen(function* () {
								retries += 1;
								yield* Effect.uninterruptible(settleDraft({ _tag: "error", message: error.message }));
								yield* events.publish(EventList.RetryScheduled, {
									timestamp: yield* DateTime.now,
									sessionId,
									attempt: retries,
									maxRetries: snapshot.retry.maxRetries,
									delayMs,
									message: error.message,
								});
								yield* Effect.sleep(Duration.millis(delayMs));
								return yield* request();
							});
						}),
					);

				const turnWindow = Effect.gen(function* () {
					yield* events.publish(EventList.TurnStarted, { timestamp: yield* DateTime.now, sessionId });
					const terminal = yield* request().pipe(
						Effect.onExit((exit) =>
							retries === 0
								? Effect.void
								: Effect.gen(function* () {
										yield* events.publish(EventList.RetryFinished, {
											timestamp: yield* DateTime.now,
											sessionId,
											attempt: retries,
											success: Exit.isSuccess(exit),
											...(Exit.isSuccess(exit)
												? {}
												: {
														message: Cause.hasInterrupts(exit.cause)
															? "interrupted"
															: errorMessage(exit.cause),
													}),
										});
									}),
						),
					);

					const interrupted = yield* settleTools(snapshot, terminal.message, terminal.reason, () => {
						committed = true;
					});
					if (interrupted !== undefined) return yield* Effect.failCause(interrupted);
					return {
						needsContinuation: terminal.reason === "toolUse",
						messageId: terminal.message.messageId,
					} satisfies TurnResult;
				});

				// `onError`, not `catchCause`: a catch handler never runs on an interrupted fiber, and
				// an interrupt is exactly when the open draft most needs settling.
				return yield* turnWindow.pipe(
					Effect.onError((cause) => {
						if (committed) return Effect.void;
						const turnCause: EventList.TurnAbortCause = Cause.hasInterrupts(cause)
							? { _tag: "interrupted" }
							: { _tag: "error", message: errorMessage(cause) };
						return Effect.gen(function* () {
							yield* settleDraft(turnCause);
							yield* events.publish(EventList.TurnAborted, {
								timestamp: yield* DateTime.now,
								sessionId,
								cause: turnCause,
							});
						});
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
