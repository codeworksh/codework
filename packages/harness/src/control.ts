/*
 * @file The control plane: the commands that start, join, and stop work on a
 * session.
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

import { Context, Effect, Layer, Option, Schema } from "effect";
import { RunnerExecution } from "./runner/execution.ts";
import type { Runner } from "./runner/run.ts";
import { SessionInput } from "./session/input/input.ts";
import type { Admitted } from "./session/input/schema.ts";
import { SessionMessageSchema } from "./session/message/schema.ts";
import type { Delivery, Prompt } from "./session/prompt/schema.ts";
import { SessionSchema } from "./session/schema.ts";
import { Session } from "./session/session.ts";

/**
 * The prompt could not be admitted under the id it was given: either that id
 * already carries different content, or it has already left the inbox. Typed
 * rather than a defect — a client that retried with a reused id can act on it.
 */
export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("PromptConflictError", {
	sessionId: Schema.String,
	messageId: Schema.String,
}) {}

export interface PromptInput {
	readonly sessionId: SessionSchema.ID;
	readonly prompt: Prompt;
	/** Supply to make the call idempotent across retries; minted when omitted. */
	readonly id?: SessionMessageSchema.ID;
	/** Defaults to "steer": join the running turn rather than waiting for the next. */
	readonly delivery?: Delivery;
}

export interface Interface {
	/**
	 * Records a prompt in the session's durable inbox, then wakes its drain.
	 *
	 * Returns once the prompt is stored, not once it is answered, and not once it
	 * is in the conversation: an admitted prompt enters the transcript at
	 * promotion, which the runner performs at the start of a turn. Between the
	 * two the inbox is the only durable record, which is what makes a crash in
	 * that window recoverable rather than a user message nothing ever answered.
	 */
	readonly prompt: (input: PromptInput) => Effect.Effect<Admitted, Session.SessionNotFoundError | PromptConflictError>;
	/** Records a prompt and awaits the drain generation responsible for it. */
	readonly run: (
		input: PromptInput,
	) => Effect.Effect<Admitted, Session.SessionNotFoundError | PromptConflictError | Runner.RunError>;
	/** Starts a drain while the session is idle, or joins the one already running. */
	readonly resume: (
		sessionId: SessionSchema.ID,
	) => Effect.Effect<void, Session.SessionNotFoundError | Runner.RunError>;
	/** Stops work owned by this process, waiting for its cleanup. Idle is a no-op. */
	readonly interrupt: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
	/** Sessions this process is currently draining. */
	readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/control/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sessions = yield* Session.Service;
		const inputs = yield* SessionInput.make;
		const execution = yield* RunnerExecution.Service;
		const isLifecycleConflict = Schema.is(SessionInput.LifecycleConflict);

		/**
		 * Uninterruptible end to end: a client that disconnects mid-call must not
		 * leave a prompt half-admitted. Everything durable happens inside `admit`,
		 * which is idempotent on the id, so a retry converges rather than
		 * duplicating.
		 */
		const admit = Effect.fn("Control.admit")(function* (input: PromptInput) {
			const session = yield* sessions.get(input.sessionId);
			if (Option.isNone(session)) {
				return yield* new Session.SessionNotFoundError({ sessionId: input.sessionId });
			}

			const messageId = input.id ?? SessionMessageSchema.ID.create();
			const delivery = input.delivery ?? "steer";
			const admitted = yield* inputs
				.admit({ id: messageId, sessionId: input.sessionId, prompt: input.prompt, delivery })
				.pipe(
					// The id already left the inbox for the conversation. That is a
					// conflict the caller can see, not a broken invariant.
					Effect.catchDefect((defect) =>
						isLifecycleConflict(defect)
							? new PromptConflictError({ sessionId: input.sessionId, messageId })
							: Effect.die(defect),
					),
				);

			// A retry that reuses an id but changes the prompt is not the same
			// request. The stored row wins, and the caller is told.
			if (!SessionInput.equivalent(admitted, { sessionId: input.sessionId, prompt: input.prompt, delivery })) {
				return yield* new PromptConflictError({ sessionId: input.sessionId, messageId });
			}

			return admitted;
		});

		const prompt = Effect.fn("Control.prompt")((input: PromptInput) =>
			Effect.uninterruptible(admit(input).pipe(Effect.tap((admitted) => execution.wake(admitted.sessionId)))),
		);

		const run = Effect.fn("Control.run")((input: PromptInput) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const admitted = yield* admit(input);
					yield* restore(execution.drain(admitted.sessionId));
					return admitted;
				}),
			),
		);

		const resume = Effect.fn("Control.resume")(function* (sessionId: SessionSchema.ID) {
			const session = yield* sessions.get(sessionId);
			if (Option.isNone(session)) return yield* new Session.SessionNotFoundError({ sessionId });
			yield* execution.resume(sessionId);
		});

		// Uninterruptible because `interrupt` waits for the owner fiber's cleanup:
		// cancelling the caller partway would abandon a stop it already started.
		const interrupt = Effect.fn("Control.interrupt")((sessionId: SessionSchema.ID) =>
			Effect.uninterruptible(execution.interrupt(sessionId)),
		);

		return Service.of({ prompt, run, resume, interrupt, active: execution.active });
	}),
);

export * as Control from "./control.ts";
