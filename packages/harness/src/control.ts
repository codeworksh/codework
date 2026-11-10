/*
 * @file The control plane: the commands that start, join, and stop work on a
 * thread.
 *
 * Session storage records what happened. Control decides whether, when, and for
 * how long a session runs. Keeping the two apart is what lets `Session.Service`
 * stay a repository — it never learns that a process manager exists, so nothing
 * below this file can reach up into fiber ownership.
 *
 * `prompt` lives here rather than on the session because admitting a prompt is
 * only half a command: the durable record is inert unless something is told to
 * drain it, and that telling is process state, not storage. Putting the pair
 * here also keeps the dependency arrows pointing one way — control depends on
 * execution and on storage, and neither depends back.
 */

import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { Event } from "./event/event.ts";
import { EventList } from "./event/list.ts";
import { Inbox } from "./inbox/inbox.ts";
import { Mcp } from "./mcp/mcp.ts";
import type { Admitted } from "./inbox/schema.ts";
import { RunnerExecution } from "./runner/execution.ts";
import type { Runner } from "./runner/run.ts";
import { SessionMessageSchema } from "./session/message/schema.ts";
import type { Delivery, Prompt } from "./session/prompt/schema.ts";
import { SessionSchema } from "./session/schema.ts";
import { Session } from "./session/session.ts";
import type { ThreadRow } from "./db/schema.sql.ts";
import { ThreadSchema } from "./thread/schema.ts";
import { Thread } from "./thread/thread.ts";

/**
 * The prompt could not be admitted under the id it was given: either that id
 * already carries different content, or it has already left the inbox. Typed
 * rather than a defect — a client that retried with a reused id can act on it.
 */
export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("PromptConflictError", {
	threadId: Schema.String,
	messageId: Schema.String,
}) {}

/** A thread of a session: `threadId`, or the session's `main` thread when absent. */
export interface ThreadRef {
	readonly sessionId: SessionSchema.ID;
	readonly threadId?: ThreadSchema.ID | undefined;
}

export interface PromptInput extends ThreadRef {
	readonly prompt: Prompt;
	/** Supply to make the call idempotent across retries; minted when omitted. */
	readonly id?: SessionMessageSchema.ID;
	/** Defaults to "steer": join the running turn rather than waiting for the next. */
	readonly delivery?: Delivery;
}

export type ResolveError = Session.SessionNotFoundError | Thread.ThreadNotFoundError;

export const RESTART_LIMIT = RunnerExecution.RESTART_LIMIT;

export interface Interface {
	/** The thread a reference names. A thread of another session is not found. */
	readonly resolve: (ref: ThreadRef) => Effect.Effect<ThreadRow, ResolveError>;
	/**
	 * Records a prompt in the thread's durable inbox, then wakes its drain.
	 *
	 * Returns once the prompt is stored, not once it is answered, and not once it
	 * is in the conversation: an admitted prompt enters the transcript at
	 * promotion, which the runner performs at the start of a turn. Between the
	 * two the inbox is the only durable record, which is what makes a crash in
	 * that window recoverable rather than a user message nothing ever answered.
	 */
	readonly prompt: (input: PromptInput) => Effect.Effect<Admitted, ResolveError | PromptConflictError>;
	/** Records a prompt, wakes execution, and waits until the thread is idle. */
	readonly run: (input: PromptInput) => Effect.Effect<Admitted, ResolveError | PromptConflictError>;
	/** Waits until the thread is idle without starting work. */
	readonly wait: (threadId: ThreadSchema.ID) => Effect.Effect<void, Thread.ThreadNotFoundError>;
	/** Starts a drain while the thread is idle, or joins the one already running. */
	readonly resume: (threadId: ThreadSchema.ID) => Effect.Effect<void, Thread.ThreadNotFoundError | Runner.RunError>;
	/**
	 * Stops work owned by this process. Idle is a no-op, except that a user stop still ends a run the
	 * last process cut off, or parks a runnable prompt, when no execution here owns the thread. Resolves
	 * once the interruption is accepted and returns whether there was work to accept it;
	 * `awaitSettlement` additionally waits for that execution's cleanup, without
	 * following work another caller admits in the meantime.
	 */
	readonly interrupt: (
		threadId: ThreadSchema.ID,
		options?: { readonly reason?: SessionSchema.InterruptReason; readonly awaitSettlement?: boolean },
	) => Effect.Effect<boolean>;
	/** Interrupts every running thread of the session; whether any was running. */
	readonly interruptSession: (
		sessionId: SessionSchema.ID,
		options?: { readonly reason?: SessionSchema.InterruptReason; readonly awaitSettlement?: boolean },
	) => Effect.Effect<boolean>;
	/** Stops the session's threads, then removes it with its log. False when there was none. */
	readonly deleteSession: (sessionId: SessionSchema.ID) => Effect.Effect<boolean>;
	/** Threads this process is currently draining. */
	readonly active: Effect.Effect<ReadonlySet<ThreadSchema.ID>>;
	/**
	 * Wakes the threads the last process left unfinished, as the server starts: a run a crash or a
	 * shutdown cut off, or a prompt woken past the thread's head. A crash counts a restart unless the
	 * run slept in retry backoff, a shutdown does not; at {@link RESTART_LIMIT} the run ends
	 * visibly instead, its queue parked for the next prompt. One thread failing to resume leaves the
	 * others resuming. Resolves once every woken thread is idle.
	 */
	readonly resumeUnfinished: Effect.Effect<void>;
	/**
	 * Ends every stored run the last process left open with a durable `execution.interrupted`, as a
	 * `crash`, or as the `user` stop it had been asked for: a shutdown ends its runs itself. Runs as the server starts, before it accepts
	 * connections and before {@link resumeUnfinished}.
	 */
	readonly sweep: Effect.Effect<void>;
	/** Prompts admitted but not yet in the conversation, steers and follow-ups, in admission order. */
	readonly pending: (threadId: ThreadSchema.ID) => Effect.Effect<ReadonlyArray<Admitted>>;
	/**
	 * Moves a pending prompt to the other lane or rewrites it, keeping its place; false when it was
	 * already promoted, cancelled, or is unknown. Asking for the steer lane also wakes the thread, so
	 * a prompt left waiting by a stop or a failure runs now.
	 */
	readonly update: (
		threadId: ThreadSchema.ID,
		id: SessionMessageSchema.ID,
		patch: Inbox.UpdatePatch,
	) => Effect.Effect<boolean>;
	/** Withdraws a pending prompt; false when it was already promoted, cancelled, or is unknown. */
	readonly cancel: (threadId: ThreadSchema.ID, id: SessionMessageSchema.ID) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/control/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sessions = yield* Session.Service;
		const threads = yield* Thread.Service;
		const inputs = yield* Inbox.make;
		const execution = yield* RunnerExecution.Service;
		const mcp = yield* Mcp.Service;
		const events = yield* Event.Service;
		const isLifecycleConflict = Schema.is(Inbox.LifecycleConflict);

		// Only a hint: the admission or move to steer already recorded the prompt's tail, which is what makes
		// it run, now or after a crash.
		const wake = (threadId: ThreadSchema.ID) => execution.wake(threadId);

		const resolve = Effect.fn("Control.resolve")(function* (ref: ThreadRef) {
			if (ref.threadId === undefined) {
				const main = yield* threads.main(ref.sessionId);
				if (Option.isSome(main)) return main.value;
				return yield* new Session.SessionNotFoundError({ sessionId: ref.sessionId });
			}
			const thread = yield* threads.get(ref.threadId);
			if (Option.isNone(thread) || thread.value.sessionId !== ref.sessionId) {
				return yield* new Thread.ThreadNotFoundError({ threadId: ref.threadId });
			}
			return thread.value;
		});

		const requireThread = Effect.fn("Control.requireThread")(function* (threadId: ThreadSchema.ID) {
			if (Option.isNone(yield* threads.get(threadId))) return yield* new Thread.ThreadNotFoundError({ threadId });
		});

		/**
		 * Uninterruptible end to end: a client that disconnects mid-call must not
		 * leave a prompt half-admitted. Everything durable happens inside `admit`,
		 * which is idempotent on the id, so a retry converges rather than
		 * duplicating.
		 */
		const admit = Effect.fn("Control.admit")(function* (input: PromptInput) {
			const thread = yield* resolve(input);
			const threadId = ThreadSchema.ID.make(thread.id);
			const messageId = input.id ?? SessionMessageSchema.ID.create();
			const delivery = input.delivery ?? "steer";
			const admitted = yield* inputs
				.admit({ id: messageId, sessionId: input.sessionId, threadId, prompt: input.prompt, delivery })
				.pipe(
					// The id already left the inbox for the conversation. That is a
					// conflict the caller can see, not a broken invariant.
					Effect.catchDefect((defect) =>
						isLifecycleConflict(defect) ? new PromptConflictError({ threadId, messageId }) : Effect.die(defect),
					),
				);

			// A retry that reuses an id but changes the prompt is not the same
			// request. The stored row wins, and the caller is told.
			if (!Inbox.equivalent(admitted, { threadId, prompt: input.prompt, delivery })) {
				return yield* new PromptConflictError({ threadId, messageId });
			}

			return admitted;
		});

		const prompt = Effect.fn("Control.prompt")((input: PromptInput) =>
			Effect.uninterruptible(admit(input).pipe(Effect.tap((admitted) => wake(admitted.threadId)))),
		);

		const run = Effect.fn("Control.run")((input: PromptInput) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const admitted = yield* admit(input);
					yield* wake(admitted.threadId);
					yield* restore(execution.awaitIdle(admitted.threadId));
					return admitted;
				}),
			),
		);

		const wait = Effect.fn("Control.wait")(function* (threadId: ThreadSchema.ID) {
			yield* requireThread(threadId);
			yield* execution.awaitIdle(threadId);
		});

		const resume = Effect.fn("Control.resume")(function* (threadId: ThreadSchema.ID) {
			yield* requireThread(threadId);
			yield* execution.resume(threadId);
		});

		const isThreadNotFound = Schema.is(Thread.ThreadNotFoundError);

		/**
		 * A user stop that found no execution here still ends what durable state says is owed a run: a run
		 * cut off by the last process and not resumed yet, or a prompt left runnable. It is recorded as the
		 * stop it is, and lands on an execution a wake started meanwhile too.
		 */
		const stopIdle = Effect.fnUntraced(function* (
			threadId: ThreadSchema.ID,
			options?: { readonly awaitSettlement?: boolean },
		) {
			const thread = yield* threads.get(threadId);
			if (Option.isNone(thread) || !(yield* threads.resumable(threadId))) return false;
			yield* events
				.publish(EventList.ExecutionInterrupted, {
					timestamp: yield* DateTime.now,
					sessionId: SessionSchema.ID.make(thread.value.sessionId),
					threadId,
					reason: "user",
				})
				.pipe(
					// Deleted between the read and the commit: the projector rolled the event back.
					Effect.catchDefect((defect) => (isThreadNotFound(defect) ? Effect.void : Effect.die(defect))),
				);
			if ((yield* execution.active).has(threadId)) yield* execution.interrupt(threadId, "user", options);
			return true;
		});

		const requestStop = Effect.fnUntraced(function* (threadId: ThreadSchema.ID) {
			const thread = yield* threads.get(threadId);
			if (Option.isNone(thread) || thread.value.runState === "idle" || Thread.stopping(thread.value)) return;
			yield* events
				.publish(EventList.ExecutionStopping, {
					timestamp: yield* DateTime.now,
					sessionId: SessionSchema.ID.make(thread.value.sessionId),
					threadId,
				})
				.pipe(Effect.catchDefect((defect) => (isThreadNotFound(defect) ? Effect.void : Effect.die(defect))));
		});

		const interrupt = Effect.fn("Control.interrupt")(
			(
				threadId: ThreadSchema.ID,
				options?: { readonly reason?: SessionSchema.InterruptReason; readonly awaitSettlement?: boolean },
			) =>
				Effect.uninterruptible(
					Effect.gen(function* () {
						const reason = options?.reason ?? "user";
						// Recorded before anything is interrupted, as a prompt is admitted before its wake: a host
						// that dies while the stop winds down ends the run as stopped instead of resuming it.
						if (reason === "user") yield* requestStop(threadId);
						if (yield* execution.interrupt(threadId, reason)) {
							// Checked again, as a futex re-reads before it sleeps: a drain that opened its run
							// between the record above and the interrupt would otherwise wind down unmarked.
							if (reason === "user") yield* requestStop(threadId);
							if (options?.awaitSettlement === true) yield* execution.interrupt(threadId, reason, options);
							return true;
						}
						// Nothing here to interrupt: durable state says whether work is still owed, now or on the
						// next start, and the stop is recorded against it.
						if (reason !== "user") return false;
						return yield* stopIdle(threadId, options);
					}),
				),
		);

		const interruptSession = Effect.fn("Control.interruptSession")(function* (
			sessionId: SessionSchema.ID,
			options?: { readonly reason?: SessionSchema.InterruptReason; readonly awaitSettlement?: boolean },
		) {
			const running = yield* execution.active;
			const owned = (yield* threads.list(sessionId)).filter((thread) =>
				running.has(ThreadSchema.ID.make(thread.id)),
			);
			const interrupted = yield* Effect.forEach(
				owned,
				(thread) => interrupt(ThreadSchema.ID.make(thread.id), options),
				{ concurrency: "unbounded" },
			);
			return interrupted.some(Boolean);
		});

		const deleteSession = Effect.fn("Control.deleteSession")(function* (sessionId: SessionSchema.ID) {
			const ids = (yield* threads.list(sessionId)).map((thread) => ThreadSchema.ID.make(thread.id));
			yield* interruptSession(sessionId, { reason: "user", awaitSettlement: true });
			const deleted = yield* sessions.delete(sessionId);
			// A prompt that woke a thread after the stop above runs on rows that are now gone; stop it too.
			const running = yield* execution.active;
			yield* Effect.forEach(
				ids.filter((id) => running.has(id)),
				(id) => interrupt(id, { reason: "user", awaitSettlement: true }),
				{ concurrency: "unbounded", discard: true },
			);
			yield* mcp.remove(sessionId);
			return deleted;
		});

		// Uninterruptible like `prompt`: a change to the steer lane that commits must also wake.
		const update = Effect.fn("Control.update")(
			(threadId: ThreadSchema.ID, id: SessionMessageSchema.ID, patch: Inbox.UpdatePatch) =>
				Effect.uninterruptible(
					Effect.gen(function* () {
						const updated = yield* inputs.update(threadId, id, patch);
						if (Option.isNone(updated)) return false;
						if (patch.delivery === "steer") yield* wake(threadId);
						return true;
					}),
				),
		);

		// Only the bell: each drain reads what its thread is owed, a resume, an end at the restart limit or
		// a parked queue, from the thread itself.
		const resumeUnfinished = Effect.gen(function* () {
			yield* Effect.forEach(
				yield* threads.unfinished,
				(row) => {
					const threadId = ThreadSchema.ID.make(row.id);
					return execution.wake(threadId).pipe(Effect.andThen(execution.awaitIdle(threadId)));
				},
				{ concurrency: "unbounded", discard: true },
			);
		}).pipe(Effect.withSpan("Control.resumeUnfinished"));

		const sweep = Effect.gen(function* () {
			// A shutdown ends its runs itself, so a run still open is one the process died in. One the user
			// had asked to stop ends as stopped: its host died while the stop wound down.
			for (const row of yield* threads.open) {
				yield* events.publish(EventList.ExecutionInterrupted, {
					timestamp: yield* DateTime.now,
					sessionId: SessionSchema.ID.make(row.sessionId),
					threadId: ThreadSchema.ID.make(row.id),
					reason: Thread.stopping(row) ? "user" : "crash",
				});
			}
		}).pipe(Effect.withSpan("Control.sweep"));

		return Service.of({
			resolve,
			prompt,
			run,
			wait,
			resume,
			interrupt,
			interruptSession,
			deleteSession,
			active: execution.active,
			resumeUnfinished,
			sweep,
			pending: inputs.pending,
			cancel: inputs.cancel,
			update,
		});
	}),
);

export * as Control from "./control.ts";
