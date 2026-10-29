/*
 * @file Implements execution contract service.
 * Connects the process coordinator to the durable input/output loop.
 */

import { Cause, Context, DateTime, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
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
import { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";

type ThreadId = ThreadSchema.ID;

export const layer = Layer.effect(
	RunnerExecution.Service,
	Effect.gen(function* () {
		const sessions = yield* Session.Service;
		const threads = yield* Thread.Service;
		const sandbox = yield* SandboxController.Controller;
		const sql = yield* SqlClient.SqlClient;
		// Captured here, not requested inside `drain`: `RunCoordinator.make`
		// requires the drain's `R` channel to be `never`, and a `Runner.Service.use`
		// in the callback would leave the tag in it.
		const runner = yield* Runner.Service;
		const events = yield* Event.Service;
		// A lifecycle publish that fails is reported, never thrown back into the
		// coordinator: losing the observation must not change how the drain ends.
		const reportLifecycle = (threadId: ThreadId, publish: Effect.Effect<unknown>) =>
			publish.pipe(
				Effect.tapCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("Failed to publish session execution lifecycle", cause).pipe(
								Effect.annotateLogs({ threadId }),
							),
				),
				Effect.ignore,
			);

		// The session a thread belongs to, for the lifecycle events its log carries. Threads never
		// move between sessions, so one lookup per thread is enough.
		const owners = new Map<ThreadId, SessionSchema.ID>();
		const sessionOf = (threadId: ThreadId) =>
			Effect.gen(function* () {
				const known = owners.get(threadId);
				if (known !== undefined) return Option.some(known);
				const thread = yield* threads.get(threadId);
				if (Option.isNone(thread)) return Option.none<SessionSchema.ID>();
				const sessionId = SessionSchema.ID.make(thread.value.sessionId);
				owners.set(threadId, sessionId);
				return Option.some(sessionId);
			});
		const publishLifecycle = (
			threadId: ThreadId,
			publish: (base: {
				readonly sessionId: SessionSchema.ID;
				readonly threadId: ThreadId;
				readonly timestamp: DateTime.Utc;
			}) => Effect.Effect<unknown>,
		) =>
			Effect.gen(function* () {
				const sessionId = yield* sessionOf(threadId);
				if (Option.isNone(sessionId)) return;
				yield* publish({ sessionId: sessionId.value, threadId, timestamp: yield* DateTime.now });
			});

		// Threads being recovered: their run neither marks the thread nor runs once it is unmarked.
		const recovering = new Set<ThreadId>();
		// The log position at each user stop: prompts admitted after it are new work, not parked by it.
		const stoppedAt = new Map<ThreadId, number>();

		const coordinator = yield* RunCoordinator.make<ThreadId, Runner.RunError, SessionSchema.InterruptReason>({
			// The run is recorded unfinished before it starts, so a process dying anywhere in it
			// leaves the thread for the next server start to resume. A recovered one already is.
			started: (threadId) =>
				reportLifecycle(
					threadId,
					(recovering.has(threadId) ? Effect.void : threads.markRunning(threadId)).pipe(
						Effect.andThen(
							publishLifecycle(threadId, (base) => events.publish(EventList.ExecutionStarted, base)),
						),
					),
				),
			// One terminal per busy period, covering every drain it coalesced.
			settled: (threadId, exit, reason) =>
				reportLifecycle(
					threadId,
					Effect.gen(function* () {
						// A shutdown leaves the run to resume on the next start; a user stop or any other end
						// finishes it.
						const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
						const stop = stoppedAt.get(threadId);
						stoppedAt.delete(threadId);
						yield* threads.endExecution(
							threadId,
							!interrupted ? "finished" : reason === "user" ? "stopped" : "closed",
							stop,
						);
						const sessionId = yield* sessionOf(threadId);
						if (Option.isNone(sessionId)) return;
						const base = { sessionId: sessionId.value, threadId, timestamp: yield* DateTime.now };
						if (Exit.isSuccess(exit)) return yield* events.publish(EventList.ExecutionSucceeded, base);
						if (Cause.hasInterruptsOnly(exit.cause))
							// Nobody named a reason, so the process took the decision itself.
							return yield* events.publish(EventList.ExecutionInterrupted, {
								...base,
								reason: reason ?? "shutdown",
							});
						return yield* events.publish(EventList.ExecutionFailed, {
							...base,
							error: SessionFailure.fromCause(Cause.squash(exit.cause)),
						});
					}),
				),
			drain: Effect.fnUntraced(function* (threadId: ThreadId, force) {
				const thread = yield* threads.get(threadId);
				if (Option.isNone(thread)) return yield* new Thread.ThreadNotFoundError({ threadId });
				const sessionId = thread.value.sessionId;
				const recovered = recovering.delete(threadId);
				if (recovered && Option.isNone(thread.value.execution)) return;
				// The thread's placement, else the session's space and directory. A placement names its
				// space in a document no FK guards, so a space gone since is typed: `relink --thread`
				// is the repair.
				const placement = yield* sessions.placement(threadId);
				if (Option.isNone(placement)) {
					return yield* new Session.SessionLinkedSpaceNotFoundError({ sessionId, threadId });
				}
				const instanceId = placement.value.space.env;
				const mount = sandbox.mount(instanceId, { cwd: placement.value.directory });

				const scopedRun = Effect.gen(function* () {
					const mountContext = yield* Layer.build(mount);
					const current = Context.get(mountContext, SandboxIO.Current);
					const fs = Context.get(mountContext, SandboxIO.FileSystem);
					if (!(yield* fs.exists(current.cwd))) {
						return yield* new Runner.SandboxDirectoryNotFoundError({
							threadId,
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
									threadId,
									sandboxInstanceId: error.sandboxInstanceId,
									directory: error.directory,
								}),
						),
					);

					return yield* runner
						.run({ threadId, force, recovered })
						.pipe(Effect.provideContext(Context.merge(locationContext, mountContext)));
				});

				return yield* scopedRun.pipe(
					Effect.scoped,
					Effect.tapCause((cause) =>
						Cause.hasDies(cause)
							? Effect.logError("defect", cause).pipe(Effect.annotateLogs({ threadId }))
							: Effect.void,
					),
				);
			}),
		});

		const interrupt: RunnerExecution.Interface["interrupt"] = (threadId, reason, options) =>
			Effect.gen(function* () {
				// The first stop of a run sets its position; a repeat while it settles keeps that one.
				const sessionId = reason === "user" && !stoppedAt.has(threadId) ? yield* sessionOf(threadId) : undefined;
				const recorded = sessionId !== undefined && Option.isSome(sessionId);
				if (recorded) stoppedAt.set(threadId, yield* events.latestSequence(sessionId.value));
				const accepted = yield* coordinator.interrupt(threadId, reason, options);
				// Nothing was running, so no settlement will read the position this call set.
				if (recorded && !accepted) stoppedAt.delete(threadId);
				return accepted;
			});

		const recover = (threadId: ThreadId) =>
			Effect.suspend(() => {
				recovering.add(threadId);
				return coordinator.run(threadId);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						recovering.delete(threadId);
					}),
				),
			);

		return RunnerExecution.Service.of({
			active: coordinator.active,
			interrupt,
			resume: coordinator.run,
			recover,
			wake: coordinator.wake,
			awaitIdle: coordinator.awaitIdle,
		});
	}),
);

export * as RunnerExecute from "./execute.ts";
