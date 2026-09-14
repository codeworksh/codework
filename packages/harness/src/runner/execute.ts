/*
 * @file Implements execution contract service.
 * Connects the process coordinator to the durable input/output loop.
 */

import { Cause, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Location } from "../location/location.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { RunCoordinator } from "./coordinator.ts";
import { RunnerExecution } from "./execution.ts";
import { Runner } from "./run.ts";

// session
import type { ID as SessionId } from "../session/schema.ts";
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
		const coordinator = yield* RunCoordinator.make<SessionId, Runner.RunError>({
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
					const locationContext = yield* Layer.build(location);

					return yield* runner
						.run({ sessionId, force })
						.pipe(Effect.provideContext(Context.merge(locationContext, mountContext)));
				});

				return yield* scopedRun.pipe(
					Effect.scoped,
					Effect.tapCause((cause) =>
						Cause.hasDies(cause)
							? Effect.logError("runner defect", cause).pipe(Effect.annotateLogs({ sessionId }))
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
