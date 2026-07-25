/*
 * @file Implements execution contract service.
 * Pulls in dependencies as required.
 */

import { Cause, Effect, Layer, Option } from "effect";
import { RunCoordinator } from "./coordinator";
import { RunnerExecution } from "./execution";
import { Runner } from "./run";

// session
import type { ID as SessionId } from "../session/schema";
import { Session } from "../session/session";

export const layer = Layer.effect(
	RunnerExecution.Service,
	Effect.gen(function* () {
		const store = yield* Session.Service;
		// Captured here, not requested inside `drain`: `RunCoordinator.make`
		// requires the drain's `R` channel to be `never`, and a `Runner.Service.use`
		// in the callback would leave the tag in it.
		const runner = yield* Runner.Service;
		const coordinator = yield* RunCoordinator.make<SessionId, Runner.RunError>({
			drain: Effect.fnUntraced(function* (sessionId: SessionId, force) {
				// `get` returns an Option, which is always truthy as an object — the
				// emptiness test has to be explicit.
				const session = yield* store.get(sessionId);
				if (Option.isNone(session)) return yield* Effect.die(`Session not found: ${sessionId}`);
				return yield* runner
					.run({ sessionId, force })
					.pipe(
						Effect.tapCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionId })),
						),
					);
			}),
		});

		return RunnerExecution.Service.of({
			active: coordinator.active,
			interrupt: coordinator.interrupt,
			resume: coordinator.run,
			wake: coordinator.wake,
		});
	}),
);

export * as RunnerExecute from "./execute";
