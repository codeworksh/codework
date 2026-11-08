/*
 * @file Implements execution contract service.
 * Connects the process coordinator to the durable input/output loop.
 */

import { Cause, Context, DateTime, Effect, Exit, Layer, Option } from "effect";
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
				if (Option.isNone(sessionId)) return;
				yield* publish({ sessionId: sessionId.value, threadId, timestamp: yield* DateTime.now });
			});

		// Threads being recovered: their run is announced as resumed.
		const recovering = new Set<ThreadId>();
		// Recovered threads whose run is ended instead of resumed, with the message it ends with.
		const abandoning = new Map<ThreadId, string>();
		// Threads whose current drain opened a run with `execution.started`.
		const opened = new Set<ThreadId>();

		const coordinator = yield* RunCoordinator.make<ThreadId, Runner.RunError, SessionSchema.InterruptReason>({
			// A drain that failed or was interrupted ends the busy period, and the run it opened ends here unless
			// it already published its own terminal: the stored run state says which, so a run ends exactly once.
			settled: (threadId, exit, reason) =>
				reportLifecycle(
					threadId,
					Effect.gen(function* () {
						const ran = opened.delete(threadId);
						if (Exit.isSuccess(exit)) return;
						const interrupted = Cause.hasInterruptsOnly(exit.cause);
						const thread = yield* threads.get(threadId);
						if (Option.isNone(thread)) return;
						// A user stop is recorded even before its run opened: it parks what woke the drain.
						if (ran ? thread.value.runState === "idle" : !(interrupted && reason === "user")) return;
						yield* publishLifecycle(threadId, (base) =>
							interrupted
								? // Nobody named a reason, so the process took the decision itself.
									events.publish(EventList.ExecutionInterrupted, { ...base, reason: reason ?? "shutdown" })
								: events.publish(EventList.ExecutionFailed, {
										...base,
										error: SessionFailure.fromCause(Cause.squash(exit.cause)),
									}),
						);
					}),
				),
			// One run per drain that runs, opened before it promotes anything: a process dying anywhere in it
			// leaves an open run, which the next server start sweeps as a crash and resumes.
			drain: Effect.fnUntraced(function* (threadId: ThreadId, force) {
				opened.delete(threadId);
				const thread = yield* threads.get(threadId);
				// Deleted with its session after something woke it: nothing is left to run.
				if (Option.isNone(thread)) return;
				const sessionId = thread.value.sessionId;
				const recovered = recovering.delete(threadId);
				// A recovery claimed the thread before its drain: a stop since then must stand.
				if (recovered && !(yield* threads.resumable(threadId))) return;
				// The doorbell is only a hint: an unforced drain runs only for a prompt woken past the head.
				if (!force && !(yield* threads.runnable(threadId))) return;
				// Whole or not at all: a stop lands either before the run opened or on an open run.
				yield* Effect.uninterruptible(
					Effect.sync(() => opened.add(threadId)).pipe(
						Effect.andThen(
							reportLifecycle(
								threadId,
								publishLifecycle(threadId, (base) =>
									events.publish(EventList.ExecutionStarted, { ...base, resumed: recovered }),
								),
							),
						),
					),
				);
				// `ended`: the run published its own terminal, `session.run.failed`. A stop arriving meanwhile
				// waits for the success to land, so `settled` finds the run ended.
				const close = (outcome: Runner.Outcome) =>
					outcome === "ended"
						? Effect.void
						: Effect.uninterruptible(
								reportLifecycle(
									threadId,
									publishLifecycle(threadId, (base) => events.publish(EventList.ExecutionSucceeded, base)),
								),
							);
				// Only the drain the abandon itself started: one it joined is a live run, which must stand.
				const abandoned = recovered && force ? abandoning.get(threadId) : undefined;
				if (abandoned !== undefined)
					return yield* runner.abandon({ threadId, message: abandoned }).pipe(Effect.flatMap(close));
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
					return yield* runner
						.run({ threadId, force, recovered })
						.pipe(Effect.provideContext(Context.merge(locationContext, mountContext)), Effect.flatMap(close));
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
			coordinator.interrupt(threadId, reason, options);

		// Under the thread's execution like any run, so a prompt that wakes it meanwhile cannot heal
		// the same draft.
		const recover = (threadId: ThreadId, abandon?: string) =>
			Effect.suspend(() => {
				recovering.add(threadId);
				if (abandon !== undefined) abandoning.set(threadId, abandon);
				return coordinator.run(threadId);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						recovering.delete(threadId);
						abandoning.delete(threadId);
					}),
				),
			);

		return RunnerExecution.Service.of({
			active: coordinator.active,
			interrupt,
			resume: coordinator.run,
			recover: (threadId) => recover(threadId),
			abandon: recover,
			wake: coordinator.wake,
			awaitIdle: coordinator.awaitIdle,
		});
	}),
);

export * as RunnerExecute from "./execute.ts";
