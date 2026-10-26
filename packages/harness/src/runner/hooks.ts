/*
 * @file Lifecycle seams of the session drain.
 *
 * The loop calls these and knows nothing about what sits behind them. The live layer is the one
 * place that fixes the order consumers run in (compaction before a loadout rebuild, context
 * projection before routing), so adding a consumer means editing it, not registering from afar.
 * Harness-internal: plugins get nothing from here.
 */

import { Context, Effect, Layer } from "effect";
import type { Admitted } from "../session/input/schema.ts";
import type { State } from "../state/state.ts";
import type { LLM } from "./llm.ts";

/** A committed turn. */
export interface Completed {
	/** The snapshot the turn ran on. */
	readonly snapshot: State.Snapshot;
	readonly messageId: string;
	/** `toolUse` means tool results wait for a reply. */
	readonly reason: "stop" | "length" | "toolUse";
	/**
	 * What the next run would promote, read without promoting it: the queued steers, or the oldest
	 * follow-up when there are none. As of the commit; input admitted later is not in it.
	 */
	readonly pending: ReadonlyArray<Admitted>;
}

/** One provider request, as the loop built it. */
export type Request = Omit<LLM.Input, "sessionId">;

export interface Attempt {
	/** 0 for the first attempt of a turn. */
	readonly retry: number;
	/** Why the previous attempt failed. */
	readonly failed?: string;
}

export type Decision = "end" | "continue";

export interface Interface {
	/** Before every turn but the first of a run, with the fresh snapshot; may replace it. */
	readonly prepareNextTurn: (turn: Completed, next: State.Snapshot) => Effect.Effect<State.Snapshot>;
	/** Before every provider attempt, retries included; may replace the request. */
	readonly prepareRequest: (request: Request, attempt: Attempt) => Effect.Effect<Request>;
	/**
	 * After a turn commits. `end` stops the run and leaves queued steers and follow-ups for the
	 * next one; `continue` asks for one more request, which the loop only sends when something
	 * was appended after the assistant message.
	 */
	readonly finishTurn: (turn: Completed) => Effect.Effect<Decision | undefined>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/hooks/Service") {}

export const layer = Layer.succeed(
	Service,
	Service.of({
		prepareNextTurn: (_turn, next) => Effect.succeed(next),
		prepareRequest: (request) => Effect.succeed(request),
		finishTurn: () => Effect.undefined,
	}),
);

export * as Hooks from "./hooks.ts";
