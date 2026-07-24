/*
 * @file Implements execution contract service.
 * Pulls in dependencies as required.
 */

import { Cause, Effect, Layer } from "effect";
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
		const coordinator = yield* RunCoordinator.make<SessionId, Runner.RunError>({
			drain: Effect.fnUntraced(function* (sessionId: SessionId, force) {
				yield* Effect.log(sessionId);
				const session = yield* store.get(sessionId);
				if (!session) return yield* Effect.die(`Session not found: ${sessionId}`);
				return yield* Runner.Service.use((runner) => runner.run({ sessionId, force })).pipe(
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
