/*
 * @file Durable thread drain.
 *
 * The loop reads queues and projections, but every durable mutation is an
 * event. LLMStarted owns the speculative draft; TurnEnded is the only commit.
 */

import { type Message, Transcript } from "@codeworksh/aikit";
import { Cause, DateTime, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import type * as ContextAssembly from "../context/assemble.ts";
import * as ContextCodec from "../context/codec.ts";
import * as Context from "../context/context.ts";
import * as Event from "../event/event.ts";
import * as EventList from "../event/list.ts";
import * as Inbox from "../inbox/inbox.ts";
import * as McpSection from "../mcp/section.ts";
import * as SessionMessageSchema from "../session/message/schema.ts";
import * as SessionSchema from "../session/schema.ts";
import type * as ThreadSchema from "../thread/schema.ts";
import * as Thread from "../thread/thread.ts";
import * as State from "../state/state.ts";
import * as Telemetry from "../telemetry/telemetry.ts";
import { errorMessage } from "../util/error.ts";
import * as Hash from "../util/hash.ts";
import * as LLMEventPublisher from "./event.ts";
import * as Hooks from "./hooks.ts";
import * as LLM from "./llm.ts";
import * as RunnerPart from "./part.ts";
import * as Retry from "./retry.ts";
import * as Runner from "./run.ts";

export type Promotion = Inbox.Boundary | undefined;

/** A turn that committed an assistant message; `undefined` when it sent no request. */
export type TurnResult =
	| (Pick<Hooks.Completed, "messageId" | "reason"> & {
			/** Whether the reply called tools, every one of them settled by now. */
			readonly toolCalls: boolean;
	  })
	| undefined;

export interface Options {
	/** Deterministic provider seam for tests. */
	readonly request?: LLM.Request;
}

const { abortedPart, endTime, terminalResult } = RunnerPart;

const encodeJson = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie);

const skippedPart = (call: Message.ToolCallPendingPart, message: string, now: number): Message.ToolCallSkippedPart => ({
	...call,
	status: "skipped",
	result: terminalResult(message),
	time: { ...call.time, end: endTime(call, now) },
});

const truncatedCall = (name: string) =>
	`Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;

/** Replies in a row cut off at the output limit with tool calls before the run ends. */
const TRUNCATION_LIMIT = 2;

const hasToolCalls = (message: Message.AssistantMessage) => message.parts.some((part) => part.type === "toolCall");

/** Whether the leaf is a reply the model finished: a cut-off one with tool calls is answered once their results are in. */
const leafAnswered = (assembled: ContextAssembly.Snapshot) => {
	const leaf =
		assembled.lastAssistant?.entryId === assembled.leafEntryId ? assembled.lastAssistant.message : undefined;
	return leaf !== undefined && (leaf.stopReason === "stop" || (leaf.stopReason === "length" && !hasToolCalls(leaf)));
};

/**
 * A request the host died with in flight counts as a failed attempt, retried like a transient
 * provider failure.
 */
const hostStopped = (snapshot: State.Snapshot, message: string) =>
	new Runner.ProviderError({
		provider: snapshot.provider,
		model: snapshot.model,
		reason: new Runner.ProviderTransportError({ message, isRetryable: true }),
	});

/** Where a resumed run's retries start: the attempts already failed, and why the last one did. */
interface Carried {
	readonly retries: number;
	/** Set when the host's death failed an attempt: the resend waits out its retry first. */
	readonly failed?: string;
}

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

/** The `mcpservers` section is the one the run started with: servers that connect mid-run show at the next run. */
const holdServers = (start: State.Snapshot, next: State.Snapshot): State.Snapshot => {
	const { [McpSection.name]: _current, ...sections } = next.prompt.sections;
	const held = start.prompt.sections[McpSection.name];
	return {
		...next,
		prompt: { ...next.prompt, sections: held === undefined ? sections : { ...sections, [McpSection.name]: held } },
	};
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

			const decodeDraft = Effect.fn("Loop.decodeDraft")(function* (draft: Thread.HydratedEntry) {
				const decoded = yield* ContextCodec.decodeMessage(draft).pipe(Effect.orDie);
				if (decoded.role !== "assistant") return yield* Effect.die(`draft ${draft.entry.id} is not an assistant`);
				return decoded;
			});

			/** The aborted entry: what streamed (`partial`, else what the draft holds), its tool calls never run. */
			const failureStub = Effect.fn("Loop.failureStub")(function* (
				draft: Thread.HydratedEntry,
				reason: "aborted" | "error",
				message: string,
				partial: Message.AssistantMessage | undefined,
			) {
				const decoded = yield* decodeDraft(draft);
				const completed = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return RunnerPart.abortCalls(
					{
						...decoded,
						stopReason: reason,
						errorMessage: message,
						time: { ...decoded.time, completed },
						parts: (partial ?? decoded).parts,
					},
					completed,
				);
			});

			const publishFailure = (
				draft: Thread.HydratedEntry,
				cause: EventList.TurnAbortCause,
				partial?: Message.AssistantMessage,
			) =>
				cause._tag === "interrupted"
					? publishAborted(draft, "aborted", "turn interrupted before commit", partial)
					: publishAborted(draft, "error", cause.message, partial);

			const publishAborted = Effect.fn("Loop.publishAborted")(function* (
				draft: Thread.HydratedEntry,
				reason: "aborted" | "error",
				message: string,
				partial: Message.AssistantMessage | undefined,
			) {
				yield* events.publish(EventList.LLMFailed, {
					timestamp: yield* DateTime.now,
					sessionId: draft.entry.sessionId,
					threadId: draft.entry.threadId,
					messageId: SessionMessageSchema.ID.from(draft.entry.id),
					reason,
					message: yield* failureStub(draft, reason, message, partial),
				});
			});

			const publishSettled = Effect.fn("Loop.publishSettled")(function* (
				ids: { readonly sessionId: SessionSchema.ID; readonly threadId: ThreadSchema.ID },
				messageId: SessionMessageSchema.ID,
				part: Message.ToolCallTerminalPart,
			) {
				yield* events.publish(EventList.ToolSettled, {
					timestamp: yield* DateTime.now,
					sessionId: ids.sessionId,
					threadId: ids.threadId,
					messageId,
					callID: part.callID,
					part,
				});
			});

			const publishCommit = Effect.fn("Loop.publishCommit")(function* (
				ids: { readonly sessionId: SessionSchema.ID; readonly threadId: ThreadSchema.ID },
				messageId: SessionMessageSchema.ID,
				recovered?: true,
			) {
				yield* events.publish(EventList.TurnEnded, {
					timestamp: yield* DateTime.now,
					sessionId: ids.sessionId,
					threadId: ids.threadId,
					messageId,
					...(recovered === undefined ? {} : { recovered }),
				});
			});

			/**
			 * Settles the draft a dead process left. One whose request was in flight (`inFlight`, why it
			 * stopped) is aborted with what streamed: the host stopped it, the provider did not fail it. One whose response ended with tool calls had them
			 * running: those not settled are aborted, never run again, and the turn commits so the model
			 * sees what ran. Anything else is aborted as interrupted.
			 */
			const healDraft = Effect.fn("Loop.healDraft")(function* (
				threadId: ThreadSchema.ID,
				inFlight: string | undefined,
			) {
				const draft = yield* threads.draft(threadId);
				if (Option.isNone(draft)) return;
				if (inFlight !== undefined) return yield* publishAborted(draft.value, "aborted", inFlight, undefined);
				const decoded = yield* decodeDraft(draft.value);
				if (!hasToolCalls(decoded)) return yield* publishFailure(draft.value, { _tag: "interrupted" });
				const ids = { sessionId: draft.value.entry.sessionId, threadId };
				const messageId = SessionMessageSchema.ID.from(decoded.messageId);
				yield* Effect.uninterruptible(
					Effect.gen(function* () {
						for (const part of decoded.parts) {
							if (part.type !== "toolCall" || (part.status !== "pending" && part.status !== "running")) continue;
							const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
							yield* publishSettled(ids, messageId, abortedPart(part, now));
						}
						yield* publishCommit(ids, messageId, true);
					}),
				);
			});

			/** Announces a retry of a failed request, then waits it out. */
			const scheduleRetry = Effect.fn("Loop.scheduleRetry")(function* (
				snapshot: State.Snapshot,
				attempt: number,
				delayMs: number,
				message: string,
			) {
				// The attempt the sleep waits for: a resume after a shutdown sends it at once, one after a crash
				// waits again first.
				yield* threads.setAttempt(snapshot.threadId, attempt + 1);
				yield* events.publish(EventList.RetryScheduled, {
					timestamp: yield* DateTime.now,
					sessionId: snapshot.sessionId,
					threadId: snapshot.threadId,
					attempt,
					maxRetries: snapshot.retry.maxRetries,
					delayMs,
					message,
				});
				yield* Effect.sleep(Duration.millis(delayMs));
			});

			/** A run that is not resumed: its execution records the end, which parks the queue. */
			const failed = (reason: ThreadSchema.RunFailedReason, message: string): Runner.Outcome => ({
				reason,
				message,
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

				const settle = (part: Message.ToolCallTerminalPart) => publishSettled(snapshot, messageId, part);
				const commit = () => publishCommit(snapshot, messageId).pipe(Effect.tap(() => Effect.sync(markCommitted)));

				yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						// The model re-issues them from these results: the drain continues as after tool use.
						if (reason === "length") {
							for (const call of pending) {
								const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
								yield* settle(skippedPart(call, truncatedCall(call.name), now));
							}
							yield* commit();
							return;
						}

						if (reason !== "toolUse") {
							for (const call of pending) {
								const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
								yield* settle(skippedPart(call, "unexpected tool call for terminal response", now));
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
									yield* settle(handled);
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
								yield* settle(abortedPart(call, now));
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
				carried: Carried | undefined,
			) {
				const { sessionId, threadId } = snapshot;
				if (promotion !== undefined) {
					const cutoff = yield* events.latestSequence(sessionId);
					const promoted = yield* inputs.promote(threadId, cutoff, promotion);
					// The pending input this turn was started for was cancelled before promotion: with no
					// earlier work to continue there is nothing to answer, so no provider request.
					if (!continuing && promoted === 0) return undefined;
				}

				const assembled = yield* context.assemble(threadId);
				if (leafAnswered(assembled)) return undefined;
				const messages = [...assembled.messages, ...(yield* declareSystemChanges(snapshot, assembled.messages))];

				// The latest attempt's publisher; a retried turn has one per provider request.
				let publisher: LLMEventPublisher.Publisher | undefined;
				let committed = false;
				// A recovered run goes on counting from the request the host died with.
				let retries = carried?.retries ?? 0;
				let failed: string | undefined = carried?.failed;

				/** Abort the latest attempt's draft, unless its own terminal event already did. */
				const settleDraft = (cause: EventList.TurnAbortCause) =>
					Effect.gen(function* () {
						if (publisher === undefined) return;
						yield* publisher.stop;
						if (publisher.startedMessageId === undefined) return;
						const stored = yield* threads.entry(publisher.startedMessageId);
						if (Option.isSome(stored) && stored.value.entry.state === "draft") {
							yield* publishFailure(stored.value, cause, publisher.partial);
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
					yield* threads.setAttempt(threadId, retries + 1);
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
								yield* scheduleRetry(snapshot, retries, delayMs, error.message);
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
					return {
						messageId: terminal.message.messageId,
						reason: terminal.reason,
						toolCalls: hasToolCalls(terminal.message),
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
				carried: Carried | undefined,
			) {
				return yield* runTurnAttempt(promotion, snapshot, continuing, carried);
			});

			const run = Effect.fn("Loop.run", { level: "Info" })(function* (input: {
				readonly threadId: ThreadSchema.ID;
				readonly force: boolean;
				readonly recovered?: boolean;
				readonly shutdown?: boolean;
			}) {
				// Only a host that stopped leaves an attempt marked: every run that ends otherwise clears it. It is
				// the request in flight, or the one a retry backoff waits for. A shutdown failed nothing: that
				// request goes again as itself. A crash failed that attempt, streaming or not: with no draft open
				// the restart went uncounted, so the retry budget is what bounds a host that keeps dying there.
				const stored = Option.getOrUndefined(
					Option.flatMap(yield* threads.get(input.threadId), (row) => row.attempt),
				);
				const streaming = Option.isSome(yield* threads.draft(input.threadId));
				const carried: Carried | undefined =
					stored === undefined
						? undefined
						: input.shutdown === true
							? { retries: stored - 1 }
							: {
									retries: stored,
									failed: streaming
										? `The host stopped while the model was answering, on attempt ${stored}`
										: `The host stopped before attempt ${stored} was sent`,
								};
				yield* healDraft(input.threadId, carried?.failed);

				const hasSteer = yield* inputs.hasPending(input.threadId, "steer");
				const hasFollowUp = yield* inputs.hasPending(input.threadId, "followUp");
				if (!input.force && !hasSteer && !hasFollowUp) return "drained" as const;
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
					hasFollowUp &&
					(yield* context
						.assemble(input.threadId)
						.pipe(Effect.map((assembled) => assembled.messages.length > 0 && !leafAnswered(assembled))));
				// A cut-off run still promotes steers that land while it loads: they join the reply being answered.
				let promotion: Promotion = cutOff ? "postTools" : hasSteer || hasFollowUp ? "final" : undefined;
				/** The steers and the oldest follow-up, in admission order: what a run promotes first. */
				const peekPending = (threadId: ThreadSchema.ID) =>
					Effect.map(inputs.pending(threadId), (queued) => {
						const followUp = queued.find((item) => item.delivery === "followUp");
						return queued.filter((item) => item.delivery === "steer" || item === followUp);
					});

				const drain = Effect.gen(function* () {
					const start = yield* state.snapshot(input.threadId);
					if (carried?.failed !== undefined) {
						const delayMs = Retry.delay(start.retry, carried.retries, hostStopped(start, carried.failed));
						if (delayMs === undefined) {
							return failed("interrupted", carried.failed);
						}
						yield* scheduleRetry(start, carried.retries, delayMs, carried.failed);
					}
					let snapshot = start;
					let continuing = input.force;
					let resent = carried;
					let truncations = 0;
					// Tool results and steers continue first; a follow-up only once both are exhausted.
					while (true) {
						const result: TurnResult = yield* runTurn(promotion, snapshot, continuing, resent);
						resent = undefined;
						// A reply cut off at the output limit gets its tool calls back as errors to re-issue.
						const truncated = result?.reason === "length" && result.toolCalls;
						const toolUse = result?.reason === "toolUse" || truncated;
						truncations = truncated ? truncations + 1 : 0;
						const completed: Hooks.Completed | undefined =
							result === undefined
								? undefined
								: {
										messageId: result.messageId,
										reason: result.reason,
										snapshot,
										pending: yield* peekPending(input.threadId),
									};
						const decision = completed === undefined ? undefined : yield* hooks.finishTurn(completed);
						// Queued steers and follow-ups start the next run.
						if (decision === "end") return "drained" as const;
						if (truncations >= TRUNCATION_LIMIT) {
							return failed(
								"truncated",
								`The response hit the output token limit with tool calls ${truncations} times in a row; the run is ended`,
							);
						}

						// A forced continuation after a finished reply sends nothing: the leaf guard in
						// `runTurnAttempt` ends the turn unless something was appended after it.
						continuing = toolUse || decision === "continue";
						const steer = yield* inputs.hasPending(input.threadId, "steer");
						// Only tool results hold a follow-up back: past them steers alone join. A reply without them is
						// a final boundary, where steers and the oldest follow-up go in together, in admission order. A
						// forced continuation rides along: the follow-up is the natural next request, the continuation
						// only its fallback.
						const followUp = !toolUse && (yield* inputs.hasPending(input.threadId, "followUp"));
						if (!continuing && !steer && !followUp) return "drained" as const;
						promotion = toolUse ? "postTools" : "final";

						const next = holdServers(start, yield* state.snapshot(input.threadId));
						snapshot = completed === undefined ? next : yield* hooks.prepareNextTurn(completed, next);
					}
				});
				return yield* Telemetry.timed(drain, (seconds, exit) =>
					Telemetry.record(Telemetry.agentDuration, seconds, Telemetry.withError({}, exit)),
				);
			});

			const abandon = Effect.fn("Loop.abandon")(function* (input: {
				readonly threadId: ThreadSchema.ID;
				readonly message: string;
			}) {
				const thread = yield* threads.get(input.threadId);
				if (Option.isNone(thread)) return "drained" as const;
				yield* healDraft(input.threadId, Option.isSome(thread.value.attempt) ? input.message : undefined);
				return failed("crashloop", input.message);
			});

			return Runner.Service.of({ run, abandon });
		}),
	);
