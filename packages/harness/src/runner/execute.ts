/*
 * @file Implements execution contract service.
 * Pulls in dependencies as required.
 */

import { Cause, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Git } from "../git/git";
import { Location } from "../location/location";
import { ProjectCopy } from "../project/copy";
import { Project } from "../project/project";
import { Sandbox } from "../sandbox/control";
import { SandboxInstance } from "../sandbox/instance";
import { SandboxIO } from "../sandbox/io";
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
		const sandbox = yield* Sandbox.Controller;
		const sql = yield* SqlClient.SqlClient;
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
				const row = session.value;
				const instanceId = SandboxInstance.fromField(row.sandboxInstanceId);
				const mount = sandbox.mount(instanceId, { cwd: row.directory });

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

					// Reuse the acquired mount: building the original mount layer again
					// would take a second reference and could attach another transport.
					const mounted = Layer.succeedContext(mountContext);
					const database = Layer.succeed(SqlClient.SqlClient, sql);
					const projectDependencies = Layer.merge(Git.layer, ProjectCopy.layer).pipe(Layer.provide(mounted));
					const project = Project.layer.pipe(
						Layer.provide(projectDependencies),
						Layer.provide(mounted),
						Layer.provide(database),
					);
					const location = Location.layer().pipe(Layer.provide(project), Layer.provide(mounted));
					const locationContext = yield* Layer.build(location);

					return yield* runner.run({ sessionId, force }).pipe(
						// The acquired session mount overrides any overlapping location
						// or ambient services without enumerating the mount contract.
						Effect.provideContext(Context.merge(locationContext, mountContext)),
					);
				});

				return yield* scopedRun.pipe(
					Effect.scoped,
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
