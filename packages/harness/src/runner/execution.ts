/*
 * @file Execution provides the drain implementation to be processed.
 * The coordinator then handles the drain fork run.
 */

import { Context, Effect, Layer } from "effect";
import { SessionSchema } from "../session/schema.ts";
import { Runner } from "./run.ts";

export interface Interface {
	/** Snapshots active execution owned by this process. */
	readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>;
	/** Starts execution while idle or joins the active execution. */
	readonly resume: (sessionId: SessionSchema.ID) => Effect.Effect<void, Runner.RunError>;
	/** Registers newly recorded work. Repeated wakeups may coalesce. */
	readonly wake: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
	/** Accepts interruption of active work. Idle interruption returns false. */
	readonly interrupt: (sessionId: SessionSchema.ID) => Effect.Effect<boolean>;
	/** Waits until this process owns no execution for the session. */
	readonly awaitIdle: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/execution/Service") {}

// Low-level compatibility layer for callers that only need durable session.
export const noopLayer = Layer.succeed(
	Service,
	Service.of({
		active: Effect.succeed(new Set()),
		resume: () => Effect.void,
		wake: () => Effect.void,
		interrupt: () => Effect.succeed(false),
		awaitIdle: () => Effect.void,
	}),
);

export * as RunnerExecution from "./execution.ts";
