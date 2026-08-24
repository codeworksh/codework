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
	/** Drains durable queued input without forcing an otherwise empty provider turn. */
	readonly drain: (sessionId: SessionSchema.ID) => Effect.Effect<void, Runner.RunError>;
	/** Registers newly recorded work. Repeated wakeups may coalesce. */
	readonly wake: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
	/** Interrupt active work owned by this process. Idle interruption is a no-op. */
	readonly interrupt: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/execution/Service") {}

// Low-level compatibility layer for callers that only need durable session.
export const noopLayer = Layer.succeed(
	Service,
	Service.of({
		active: Effect.succeed(new Set()),
		resume: () => Effect.void,
		drain: () => Effect.void,
		wake: () => Effect.void,
		interrupt: () => Effect.void,
	}),
);

export * as RunnerExecution from "./execution.ts";
