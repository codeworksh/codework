/*
 * @file Implements execution contract service.
 * Connects the process coordinator to the durable input/output loop.
 */

import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Store } from "../db/store.ts";
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
import { Mcp } from "../mcp/mcp.ts";
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
		const store = yield* Store.Service;
		// Captured here, not requested inside `drain`: `RunCoordinator.make`
		// requires the drain's `R` channel to be `never`, and a `Runner.Service.use`
		// in the callback would leave the tag in it.
		const runner = yield* Runner.Service;
		const events = yield* Event.Service;
		const mcp = yield* Mcp.Service;
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

		// The session a thread belongs to, for the lifecycle events its log carries. Read every time, not
		// cached: the events are durable, and one for a session deleted since would recreate its log.
		const isThreadNotFound = Schema.is(Thread.ThreadNotFoundError);
		const isRunStopping = Schema.is(Thread.RunStoppingError);
		const sessionOf = (threadId: ThreadId) =>
			threads.get(threadId).pipe(Effect.map(Option.map((thread) => SessionSchema.ID.make(thread.sessionId))));
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
				if (Option.isNone(sessionId)) return false;
				return yield* publish({ sessionId: sessionId.value, threadId, timestamp: yield* DateTime.now }).pipe(
					Effect.as(true),
					// Deleted between the read and the commit: the projector rolled the event back.
					Effect.catchDefect((defect) => (isThreadNotFound(defect) ? Effect.succeed(false) : Effect.die(defect))),
				);
			});

		const coordinator = yield* RunCoordinator.make<ThreadId, Runner.RunError, SessionSchema.InterruptReason>({
			// A drain that failed or was interrupted ends the busy period, and the run it left open ends here: one
			// that published its own terminal is idle by now, so a run ends exactly once.
			settled: (threadId, exit, reason) =>
				reportLifecycle(
					threadId,
					Effect.gen(function* () {
						if (Exit.isSuccess(exit)) return;
						const interrupted = Cause.hasInterruptsOnly(exit.cause);
						const thread = yield* threads.get(threadId);
						if (Option.isNone(thread)) return;
						const open = thread.value.runState !== "idle";
						// The stop a run was asked for is on its row, and outlasts whatever interrupted it since.
						const stop = interrupted && (reason === "user" || Thread.stopping(thread.value));
						// With no run open, before it opened or after it ended, a user stop is recorded only when
						// something would otherwise still run, now or on the next start.
						if (!open && !(stop && (yield* threads.resumable(threadId)))) return;
						const interruptedAs = (as: SessionSchema.InterruptReason) =>
							publishLifecycle(threadId, (base) =>
								events.publish(EventList.ExecutionInterrupted, { ...base, reason: as }),
							);
						if (!interrupted) {
							return yield* publishLifecycle(threadId, (base) =>
								events.publish(EventList.ExecutionFailed, {
									...base,
									error: SessionFailure.fromCause(Cause.squash(exit.cause)),
								}),
							);
						}
						// Nobody named a reason, so the process took the decision itself. A stop recorded since the
						// read above rolls that end back: the run then ends as the user's.
						yield* interruptedAs(stop ? "user" : (reason ?? "shutdown")).pipe(
							Effect.catchDefect((defect) =>
								isRunStopping(defect) ? interruptedAs("user") : Effect.die(defect),
							),
						);
					}),
				),
			// Level-triggered: work still runnable as a drain ends (queued behind a hook's `end`, or left by a
			// lost lifecycle publish) is drained again rather than left waiting for a bell.
			drain: (threadId: ThreadId, force: boolean): Effect.Effect<void, Runner.RunError> =>
				drainOnce(threadId, force).pipe(
					Effect.tapCause((cause) =>
						Cause.hasDies(cause)
							? Effect.logError("defect", cause).pipe(Effect.annotateLogs({ threadId }))
							: Effect.void,
					),
					Effect.tap(() =>
						Effect.gen(function* () {
							if (yield* threads.runnable(threadId)) yield* coordinator.wake(threadId);
						}),
					),
				),
		});

		/*
		 * One run per drain that runs, opened before it promotes anything: a process dying anywhere in it
		 * leaves an open run, which the next server start sweeps as a crash. What to do is read from the
		 * thread, never from what woke the drain: a run the host cut off is resumed, or ended at the restart
		 * limit, by whichever drain gets to it first.
		 */
		const drainOnce = Effect.fnUntraced(function* (threadId: ThreadId, force: boolean) {
			const thread = yield* threads.get(threadId);
			// Deleted with its session after something woke it: nothing is left to run.
			if (Option.isNone(thread)) return;
			const sessionId = thread.value.sessionId;
			// Read before `execution.started` clears it.
			const cut = Option.exists(
				thread.value.runError,
				(error) => error._tag === "interrupted" && error.reason !== "user",
			);
			const shutdown = Option.exists(
				thread.value.runError,
				(error) => error._tag === "interrupted" && error.reason === "shutdown",
			);
			// Counted before resuming, so a crash inside the resumed run is counted too. None: a stop since
			// the read ended the run, and stands.
			const restarts =
				cut && thread.value.runState === "idle" ? yield* threads.claimRestart(threadId) : Option.none();
			const recovered = Option.isSome(restarts);
			// The doorbell is only a hint: an unforced drain runs only for a prompt woken past the head.
			if (!recovered && !force && !(yield* threads.runnable(threadId))) return;
			// Whole or not at all: a stop lands either before the run opened or on an open run. A run that
			// cannot be opened does not run.
			const started = yield* Effect.uninterruptible(
				publishLifecycle(threadId, (base) =>
					events.publish(EventList.ExecutionStarted, { ...base, resumed: recovered }),
				),
			);
			if (!started) return;
			// Every terminal a run that returned gets is published here, joined to its last step: a stop or a
			// shutdown lands on the open run or after its end, never between the two.
			const close = (outcome: Runner.Outcome) =>
				reportLifecycle(
					threadId,
					publishLifecycle(threadId, (base) =>
						outcome === "drained"
							? events.publish(EventList.ExecutionSucceeded, base)
							: events.publish(EventList.RunFailed, { ...base, ...outcome }),
					),
				);
			const ending = <E, R>(run: Effect.Effect<Runner.Outcome, E, R>) =>
				Effect.uninterruptibleMask((restore) => restore(run).pipe(Effect.flatMap(close)));
			if (recovered && restarts.value >= RunnerExecution.RESTART_LIMIT) {
				return yield* ending(
					runner.abandon({
						threadId,
						message: `The run was interrupted ${restarts.value} times in a row; it is not resumed again`,
					}),
				);
			}
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
					Layer.provide(Layer.succeed(Store.Service, store)),
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

				// The thread's MCP servers stay open while its drain runs, and idle out after.
				yield* mcp.lease({ sessionId, threadId });
				return yield* ending(
					runner
						.run({ threadId, force: force || recovered, recovered, shutdown })
						.pipe(Effect.provideContext(Context.merge(locationContext, mountContext))),
				);
			});

			return yield* scopedRun.pipe(Effect.scoped);
		});

		const interrupt: RunnerExecution.Interface["interrupt"] = (threadId, reason, options) =>
			coordinator.interrupt(threadId, reason, options);

		return RunnerExecution.Service.of({
			active: coordinator.active,
			interrupt,
			resume: coordinator.run,
			wake: coordinator.wake,
			awaitIdle: coordinator.awaitIdle,
		});
	}),
);

export * as RunnerExecute from "./execute.ts";
