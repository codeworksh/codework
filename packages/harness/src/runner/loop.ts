/*
 * @file Durable thread drain.
 *
 * The loop reads queues and projections, but every durable mutation is an
 * event. LLMStarted owns the speculative draft; TurnEnded is the only commit.
 */

import { type Message, Transcript } from "@codeworksh/aikit";
import { Cause, DateTime, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { ContextCodec } from "../context/codec.ts";
import { Context } from "../context/context.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { Inbox } from "../inbox/inbox.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
import { State } from "../state/state.ts";
import { Telemetry } from "../telemetry/telemetry.ts";
import { errorMessage } from "../util/error.ts";
import { Hash } from "../util/hash.ts";
import { LLMEventPublisher } from "./event.ts";
import { Hooks } from "./hooks.ts";
import { LLM } from "./llm.ts";
import { Retry } from "./retry.ts";
import { Runner } from "./run.ts";

export type Promotion = "steer" | "followUp" | undefined;

/** A turn that committed an assistant message; `undefined` when it sent no request. */
export type TurnResult = Pick<Hooks.Completed, "messageId" | "reason"> | undefined;

export interface Options {
	/** Deterministic provider seam for tests. */
	readonly request?: LLM.Request;
}

const terminalResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	isError: true as const,
});

const encodeJson = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie);

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

const observeTool = (
	snapshot: State.Snapshot,
	call: Message.ToolCallPendingPart,
	seconds: number,
	exit: Exit.Exit<Message.ToolCallTerminalPart, unknown>,
) => {
	// The model names the tool; an unregistered name would open a new series per hallucination.
	const tool = snapshot.tools.defs.some((def) => def.name === call.name) ? call.name : "_OTHER";
	const labels = Exit.isFailure(exit)
		? { tool, error: Telemetry.errorType(exit.cause) }
		: exit.value.status === "completed"
			? { tool }
			: { tool, error: exit.value.status };
	return Telemetry.record(Telemetry.toolDuration, seconds, labels);
};

export const layer = (options: Options = {}) =>
	Layer.effect(
		Runner.Service,
		Effect.gen(function* () {
			const context = yield* Context.Service;
			const events = yield* Event.Service;
			const hooks = yield* Hooks.Service;
			const inputs = yield* Inbox.make;
			const threads = yield* Thread.Service;
			const state = yield* State.Service;
			const requestLLM = options.request ?? LLM.run;

			const failureStub = Effect.fn("Loop.failureStub")(function* (
				draft: Thread.HydratedEntry,
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
				draft: Thread.HydratedEntry,
				cause: EventList.TurnAbortCause,
			) {
				const reason = cause._tag === "interrupted" ? "aborted" : "error";
				const message = cause._tag === "interrupted" ? "turn interrupted before commit" : cause.message;
				yield* events.publish(EventList.LLMFailed, {
					timestamp: yield* DateTime.now,
					sessionId: draft.entry.sessionId,
					threadId: draft.entry.threadId,
					messageId: SessionMessageSchema.ID.from(draft.entry.id),
					reason,
					message: yield* failureStub(draft, reason, message),
				});
			});

			const healDanglingDraft = Effect.fn("Loop.healDanglingDraft")(function* (threadId: ThreadSchema.ID) {
				const draft = yield* threads.draft(threadId);
				if (Option.isNone(draft)) return;
				yield* publishFailure(draft.value, { _tag: "interrupted" });
			});

			const settleTools = Effect.fn("Loop.settleTools", { level: "Info" })(function* (
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
						threadId: snapshot.threadId,
						messageId,
						callID: call.callID,
						part,
					});
				});
				const commit = Effect.fn("Loop.commitTurn")(function* () {
					yield* events.publish(EventList.TurnEnded, {
						timestamp: yield* DateTime.now,
						sessionId: snapshot.sessionId,
						threadId: snapshot.threadId,
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
						const handle = Effect.fn("Loop.handleTool", { level: "Info" })(function* (
							call: Message.ToolCallPendingPart,
						) {
							yield* Effect.annotateCurrentSpan({
								"gen_ai.operation.name": "execute_tool",
								"gen_ai.tool.name": call.name,
								"gen_ai.tool.call.id": call.callID,
							});
							yield* events.publish(EventList.ToolStarted, {
								timestamp: yield* DateTime.now,
								sessionId: snapshot.sessionId,
								threadId: snapshot.threadId,
								messageId,
								callID: call.callID,
								name: call.name,
								label: snapshot.tools.defs.find((def) => def.name === call.name)?.label,
								arguments: call.arguments,
							});
							const execute = snapshot.tools
								.handle(call, {
									sessionId: snapshot.sessionId,
									threadId: snapshot.threadId,
									messageId,
									modelInput: snapshot.resolvedModel.input,
									onProgress: (progress) =>
										events
											.publish(EventList.ToolProgress, {
												timestamp: DateTime.makeUnsafe(progress.toolCall.time.end),
												sessionId: snapshot.sessionId,
												threadId: snapshot.threadId,
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
							const handled = yield* Telemetry.timed(execute, (seconds, exit) =>
								observeTool(snapshot, call, seconds, exit),
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

			/**
			 * The request keeps the foundation as `systemPrompt` and the declared tools as `tools`. The
			 * prompt sections, and what the thread offers beyond those tools (or withholds), are declared
			 * by a `system` entry, published when the transcript's state differs from the snapshot's: the
			 * first request declares every section. Returns its message, for the request at hand.
			 */
			const declareSystemChanges = Effect.fn("Loop.declareSystemChanges")(function* (
				snapshot: State.Snapshot,
				messages: ReadonlyArray<Message.Message>,
			) {
				const previous = Transcript.resolveTranscriptTools(
					{ messages: [...messages], tools: [...snapshot.tools.wire] },
					"none",
				).requestTools;
				const tools = Transcript.getToolStateChanges(previous, snapshot.tools.offered);
				const sections = Transcript.diffSections(Transcript.getCurrentSections(messages), snapshot.prompt.sections);
				if (sections === undefined && tools.toolsAdded.length === 0 && tools.toolsRemoved.length === 0) return [];
				const changes = { ...(sections === undefined ? {} : { sections }), ...tools };
				const messageId = SessionMessageSchema.ID.create();
				const timestamp = yield* DateTime.now;
				const hash = Hash.sha256(yield* encodeJson(snapshot.tools.offered.map(Transcript.toToolDeclaration)));
				yield* events.publish(EventList.SystemChanged, {
					timestamp,
					sessionId: snapshot.sessionId,
					threadId: snapshot.threadId,
					messageId,
					...changes,
					hash,
				});
				return [
					ContextCodec.systemMessage(messageId, DateTime.toEpochMillis(timestamp), changes),
				] satisfies ReadonlyArray<Message.SystemMessage>;
			});

			const runTurnAttempt = Effect.fn("Loop.runTurnAttempt", { level: "Info" })(function* (
				promotion: Promotion,
				snapshot: State.Snapshot,
				continuing: boolean,
			) {
				const { sessionId, threadId } = snapshot;
				if (promotion !== undefined) {
					const cutoff = yield* events.latestSequence(sessionId);
					const followUp = promotion === "followUp" && (yield* inputs.promoteFollowUp(threadId));
					const steers = yield* inputs.promoteSteers(threadId, cutoff);
					// The pending input this turn was started for was cancelled before promotion: with no
					// earlier work to continue there is nothing to answer, so no provider request.
					if (!continuing && !followUp && steers === 0) return undefined;
				}

				const assembled = yield* context.assemble(threadId);
				const leaf =
					assembled.lastAssistant?.entryId === assembled.leafEntryId ? assembled.lastAssistant.message : undefined;
				if (leaf !== undefined && (leaf.stopReason === "stop" || leaf.stopReason === "length")) {
					return undefined;
				}
				const messages = [...assembled.messages, ...(yield* declareSystemChanges(snapshot, assembled.messages))];

				// The latest attempt's publisher; a retried turn has one per provider request.
				let publisher: LLMEventPublisher.Publisher | undefined;
				let committed = false;
				let retries = 0;
				let failed: string | undefined;

				/** Abort the latest attempt's draft, unless its own terminal event already did. */
				const settleDraft = (cause: EventList.TurnAbortCause) =>
					Effect.gen(function* () {
						if (publisher?.startedMessageId === undefined) return;
						const stored = yield* threads.entry(publisher.startedMessageId);
						if (Option.isSome(stored) && stored.value.entry.state === "draft") {
							yield* publishFailure(stored.value, cause);
						}
					});

				const attempt = Effect.gen(function* () {
					publisher = yield* LLMEventPublisher.make({ sessionId, threadId }).pipe(
						Effect.provideService(Event.Service, events),
					);
					const prepared = yield* hooks.prepareRequest(
						{
							context: {
								systemPrompt: snapshot.prompt.foundation,
								messages: [...messages],
								tools: [...snapshot.tools.wire],
								deferredTools: [...snapshot.tools.deferred],
							},
							provider: snapshot.provider,
							model: snapshot.model,
							resolvedModel: snapshot.resolvedModel,
							thinkingLevel: snapshot.thinkingLevel,
							options: snapshot.request,
							settings: snapshot.settings,
						},
						{ retry: retries, ...(failed === undefined ? {} : { failed }) },
					);
					const terminal = yield* requestLLM({ threadId, ...prepared, publisher });

					if (terminal.outcome === "failed") {
						if (terminal.reason === "aborted") return yield* Effect.interrupt;
						return yield* LLM.providerError(
							{ provider: prepared.provider, model: prepared.model },
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
								failed = error.message;
								yield* Effect.uninterruptible(settleDraft({ _tag: "error", message: error.message }));
								yield* events.publish(EventList.RetryScheduled, {
									timestamp: yield* DateTime.now,
									sessionId,
									threadId,
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
					yield* events.publish(EventList.TurnStarted, { timestamp: yield* DateTime.now, sessionId, threadId });
					const terminal = yield* request().pipe(
						Effect.onExit((exit) =>
							retries === 0
								? Effect.void
								: Effect.gen(function* () {
										yield* events.publish(EventList.RetryFinished, {
											timestamp: yield* DateTime.now,
											sessionId,
											threadId,
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
					return { messageId: terminal.message.messageId, reason: terminal.reason } satisfies TurnResult;
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
								threadId,
								cause: turnCause,
							});
						});
					}),
				);
			});

			/** `continuing`: earlier work (tool results, a forced resume) needs a reply even when nothing is promoted. */
			const runTurn = Effect.fn("Loop.runTurn", { level: "Info" })(function* (
				promotion: Promotion,
				snapshot: State.Snapshot,
				continuing: boolean,
			) {
				return yield* runTurnAttempt(promotion, snapshot, continuing);
			});

			const run = Effect.fn("Loop.run", { level: "Info" })(function* (input: {
				readonly threadId: ThreadSchema.ID;
				readonly force: boolean;
				readonly recovered?: boolean;
			}) {
				yield* healDanglingDraft(input.threadId);

				const hasSteer = yield* inputs.hasPending(input.threadId, "steer");
				const hasFollowUp = hasSteer ? false : yield* inputs.hasPending(input.threadId, "followUp");
				if (!input.force && !hasSteer && !hasFollowUp) return;
				yield* Effect.annotateCurrentSpan({
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.name": "codework",
					"gen_ai.conversation.id": input.threadId,
				});

				// A recovered or explicitly resumed run first answers the reply it stopped in (cut off, or ended
				// after a tool batch), from the same committed messages, before a queued follow-up goes in; steers
				// join it either way. A wake from a new prompt is neither: its input goes in where it lands.
				const cutOff =
					(input.recovered === true || input.force) &&
					!hasSteer &&
					hasFollowUp &&
					(yield* context.assemble(input.threadId).pipe(
						Effect.map((assembled) => {
							const leaf =
								assembled.lastAssistant?.entryId === assembled.leafEntryId
									? assembled.lastAssistant.message
									: undefined;
							return (
								assembled.messages.length > 0 && leaf?.stopReason !== "stop" && leaf?.stopReason !== "length"
							);
						}),
					));
				// A cut-off run still promotes steers that land while it loads: they join the reply being answered.
				let promotion: Promotion = hasSteer || cutOff ? "steer" : hasFollowUp ? "followUp" : undefined;
				/** Steers when there are any, else the oldest follow-up: what a run promotes first. */
				const peekPending = (threadId: ThreadSchema.ID) =>
					Effect.map(inputs.pending(threadId), (queued) => {
						const steers = queued.filter((item) => item.delivery === "steer");
						return steers.length > 0 ? steers : queued.slice(0, 1);
					});

				const drain = Effect.gen(function* () {
					let snapshot = yield* state.snapshot(input.threadId);
					let continuing = input.force;
					// Tool results and steers continue first; a follow-up only once both are exhausted.
					while (true) {
						const result: TurnResult = yield* runTurn(promotion, snapshot, continuing);
						const toolUse = result?.reason === "toolUse";
						const completed: Hooks.Completed | undefined =
							result === undefined
								? undefined
								: { ...result, snapshot, pending: yield* peekPending(input.threadId) };
						const decision = completed === undefined ? undefined : yield* hooks.finishTurn(completed);
						// Queued steers and follow-ups stay for the next run.
						if (decision === "end") return;

						// A forced continuation after a finished reply sends nothing: the leaf guard in
						// `runTurnAttempt` ends the turn unless something was appended after it.
						continuing = toolUse || decision === "continue";
						const steer = yield* inputs.hasPending(input.threadId, "steer");
						// Only tool results outrank a follow-up. A forced continuation rides along with it: the
						// follow-up is the natural next request, and the continuation only its fallback.
						const followUp = !toolUse && !steer && (yield* inputs.hasPending(input.threadId, "followUp"));
						if (!continuing && !steer && !followUp) return;
						promotion = followUp ? "followUp" : "steer";

						const next = yield* state.snapshot(input.threadId);
						snapshot = completed === undefined ? next : yield* hooks.prepareNextTurn(completed, next);
					}
				});
				yield* Telemetry.timed(drain, (seconds, exit) =>
					Telemetry.record(Telemetry.agentDuration, seconds, Telemetry.withError({}, exit)),
				);
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop.ts";
