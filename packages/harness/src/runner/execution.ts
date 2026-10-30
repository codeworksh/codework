/*
 * @file Execution provides the drain implementation to be processed.
 * The coordinator then handles the drain fork run.
 */

import { Context, Effect, Layer } from "effect";
import type { SessionSchema } from "../session/schema.ts";
import type { ThreadSchema } from "../thread/schema.ts";
import { Runner } from "./run.ts";

export interface Interface {
	/** Snapshots active execution owned by this process. */
	readonly active: Effect.Effect<ReadonlySet<ThreadSchema.ID>>;
	/** Starts execution while idle or joins the active execution. */
	readonly resume: (threadId: ThreadSchema.ID) => Effect.Effect<void, Runner.RunError>;
	/**
	 * Resumes a run the last process left unfinished. Like `resume`, except that it marks nothing,
	 * and runs nothing when the thread is no longer marked as it begins: a stop that landed since
	 * recovery chose the thread stands.
	 */
	readonly recover: (threadId: ThreadSchema.ID) => Effect.Effect<void, Runner.RunError>;
	/** Registers newly recorded work. Repeated wakeups may coalesce. */
	readonly wake: (threadId: ThreadSchema.ID) => Effect.Effect<void>;
	/**
	 * Accepts interruption of active work. Idle interruption returns false.
	 * `awaitSettlement` waits for the interrupted execution's cleanup only.
	 */
	readonly interrupt: (
		threadId: ThreadSchema.ID,
		reason?: SessionSchema.InterruptReason,
		options?: { readonly awaitSettlement?: boolean },
	) => Effect.Effect<boolean>;
	/** Waits until this process owns no execution for the thread. */
	readonly awaitIdle: (threadId: ThreadSchema.ID) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/execution/Service") {}

// Low-level compatibility layer for callers that only need durable threads.
export const noopLayer = Layer.succeed(
	Service,
	Service.of({
		active: Effect.succeed(new Set()),
		resume: () => Effect.void,
		recover: () => Effect.void,
		wake: () => Effect.void,
		interrupt: () => Effect.succeed(false),
		awaitIdle: () => Effect.void,
	}),
);

export * as RunnerExecution from "./execution.ts";
