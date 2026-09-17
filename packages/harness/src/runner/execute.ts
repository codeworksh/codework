/*
 * @file Implements execution contract service.
 * Connects the process coordinator to the durable input/output loop.
 */

import { Cause, Context, DateTime, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { Location } from "../location/location.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { RunCoordinator } from "./coordinator.ts";
import { RunnerExecution } from "./execution.ts";
import { Runner } from "./run.ts";

// session
import { SessionFailure } from "../session/failure.ts";
import type { ID as SessionId } from "../session/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";

export const layer = Layer.effect(
	RunnerExecution.Service,
	Effect.gen(function* () {
		const store = yield* Session.Service;
		const sandbox = yield* SandboxController.Controller;
		const sql = yield* SqlClient.SqlClient;
		// Captured here, not requested inside `drain`: `RunCoordinator.make`
		// requires the drain's `R` channel to be `never`, and a `Runner.Service.use`
		// in the callback would leave the tag in it.
		const runner = yield* Runner.Service;
		const events = yield* Event.Service;
		// A lifecycle publish that fails is reported, never thrown back into the
		// coordinator: losing the observation must not change how the drain ends.
		const reportLifecycle = (sessionId: SessionId, publish: Effect.Effect<unknown>) =>
			publish.pipe(
				Effect.tapCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("Failed to publish session execution lifecycle", cause).pipe(
								Effect.annotateLogs({ sessionId }),
							),
				),
				Effect.ignore,
			);

		const coordinator = yield* RunCoordinator.make<SessionId, Runner.RunError, SessionSchema.InterruptReason>({
			started: (sessionId) =>
				reportLifecycle(
					sessionId,
					DateTime.now.pipe(
						Effect.andThen((timestamp) => events.publish(EventList.ExecutionStarted, { sessionId, timestamp })),
					),
				),
			// One terminal per busy period, covering every drain it coalesced.
			settled: (sessionId, exit, reason) =>
				reportLifecycle(
					sessionId,
					Effect.gen(function* () {
						const timestamp = yield* DateTime.now;
						if (Exit.isSuccess(exit))
							return yield* events.publish(EventList.ExecutionSucceeded, { sessionId, timestamp });
						if (Cause.hasInterruptsOnly(exit.cause))
							// Nobody named a reason, so the process took the decision itself.
							return yield* events.publish(EventList.ExecutionInterrupted, {
								sessionId,
								timestamp,
								reason: reason ?? "shutdown",
							});
						return yield* events.publish(EventList.ExecutionFailed, {
							sessionId,
							timestamp,
							error: SessionFailure.fromCause(Cause.squash(exit.cause)),
						});
					}),
				),
			drain: Effect.fnUntraced(function* (sessionId: SessionId, force) {
				const session = yield* store.get(sessionId);
				if (Option.isNone(session)) return yield* new Session.SessionNotFoundError({ sessionId });
				const space = yield* store.space(sessionId);
				// Unreachable while the FK holds; typed so a UI can offer relink
				// as the repair instead of surfacing a defect.
				if (Option.isNone(space)) return yield* new Session.SessionLinkedSpaceNotFoundError({ sessionId });
				// The session's env is derived through its space; its cwd is its own (D-SESSION).
				const instanceId = space.value.env;
				const mount = sandbox.mount(instanceId, { cwd: session.value.directory });

				const scopedRun = Effect.gen(function* () {
					const mountContext = yield* Layer.build(mount);
					const current = Context.get(mountContext, SandboxIO.Current);
					const fs = Context.get(mountContext, SandboxIO.FileSystem);
					if (!(yield* fs.exists(current.cwd))) {
						return yield* new Runner.SandboxDirectoryNotFoundError({
							sessionId,
							sandboxInstanceId: instanceId,
							directory: current.cwd,
						});
					}

					const location = Location.layerMounted().pipe(
						Layer.provide(Layer.succeedContext(mountContext)),
						Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
					);
					const locationContext = yield* Layer.build(location).pipe(
						Effect.catchTag(
							["Location.DirectoryNotFoundError", "Location.NotDirectoryError"],
							(error) =>
								new Runner.SandboxDirectoryNotFoundError({
									sessionId,
									sandboxInstanceId: error.sandboxInstanceId,
									directory: error.directory,
								}),
						),
					);

					return yield* runner
						.run({ sessionId, force })
						.pipe(Effect.provideContext(Context.merge(locationContext, mountContext)));
				});

				return yield* scopedRun.pipe(
					Effect.scoped,
					Effect.tapCause((cause) =>
						Cause.hasDies(cause)
							? Effect.logError("defect", cause).pipe(Effect.annotateLogs({ sessionId }))
							: Effect.void,
					),
				);
			}),
		});

		return RunnerExecution.Service.of({
			active: coordinator.active,
			interrupt: coordinator.interrupt,
			resume: coordinator.run,
			wake: coordinator.wake,
			awaitIdle: coordinator.awaitIdle,
		});
	}),
);

export * as RunnerExecute from "./execute.ts";
