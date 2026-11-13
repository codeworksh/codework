/**
 * Runs space daemons: one instance of each builtin daemon per space, started on the first drain
 * that mounts the space and stopped after the space has been idle.
 *
 * Attribution: a thread's session events belong to a space from its drain's `space.mount.attached`
 * to its `space.mount.detached`. Those, and the mount events themselves, go to the space's daemons
 * in publish order.
 *
 * Reads never wake a sandbox. A daemon borrows the sandbox's I/O only while a drain holds it; when
 * the last drain of a space lets go with work still pending, the host keeps the sandbox borrowable
 * for one handover window, taken while that drain's lease is still held.
 */
import type { Daemon } from "@codeworksh/plugin/plugin";
import { SqlClient } from "effect/sql";
import { Cause, Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope } from "effect";
import * as Event from "../event/event.ts";
import * as EventList from "../event/list.ts";
import { EventSchema } from "../event/schema.ts";
import * as SandboxController from "../sandbox/control.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import * as Work from "./work.ts";
import { Detached, BudgetExceeded } from "@codeworksh/plugin/plugin/daemon";

export class DaemonCallError extends Schema.TaggedError<DaemonCallError>()("DaemonCallError", {
	reason: Schema.Literals([
		"unavailable",
		"detached",
		"method_not_found",
		"invalid_input",
		"invalid_output",
		"failed",
	]),
	message: Schema.String,
}) {}

/** A daemon's `start` ran past its deadline; it is left out until the next mount. */
class DaemonStartTimeout extends Schema.TaggedError<DaemonStartTimeout>()("DaemonStartTimeout", {
	daemon: Schema.String,
}) {}

export interface CallInput {
	readonly plugin: string;
	readonly spaceId: string;
	readonly method: string;
	readonly input?: unknown;
}

export interface Interface {
	/** Call a running daemon's method; never starts an instance and never wakes a sandbox. */
	readonly call: (input: CallInput) => Effect.Effect<unknown, DaemonCallError>;
	/** The last event of each of `types` every space daemon published, for a client that subscribes now. */
	readonly last: (types: ReadonlySet<string>) => ReadonlyArray<EventSchema.Payload>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/daemon/host/Service") {}

export interface Options {
	readonly daemons: ReadonlyArray<Daemon.DaemonPlugin>;
	/** A space with no drain for this long stops its daemons. Default: 60 minutes. */
	readonly idleTimeout?: Duration.Input;
	/** How long a sandbox stays borrowable after its last drain let go with work pending. Default: 30 seconds. */
	readonly handover?: Duration.Input;
}

type Handler = (event: EventSchema.Payload) => Effect.Effect<void>;
type MethodHandler = (input: unknown) => Effect.Effect<unknown, Error | { readonly _tag: string }>;

interface Running {
	readonly daemon: Daemon.DaemonPlugin;
	readonly queue: Queue.Queue<EventSchema.Payload>;
	readonly handlers: Map<string, Array<Handler>>;
	readonly methods: Map<string, MethodHandler>;
	readonly works: Array<Work.Work>;
	started: boolean;
	/** Events offered and not yet handled. */
	pending: number;
}

interface Instance {
	readonly spaceId: string;
	readonly scope: Scope.Closeable;
	readonly plugins: Map<string, Running>;
	space: Daemon.SpaceInfo | undefined;
	env: SandboxInstance.ID | undefined;
	idle: Fiber.Fiber<void> | undefined;
}

const isDetached = Schema.is(Detached);

const threadOf = (event: EventSchema.Payload): string | undefined => {
	const data: unknown = event.data;
	return typeof data === "object" && data !== null && "threadId" in data && typeof data.threadId === "string"
		? data.threadId
		: undefined;
};

export const layer = (options: Options) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const controller = yield* SandboxController.Controller;
			const sql = yield* SqlClient.SqlClient;
			const root = yield* Effect.scope;
			const idleTimeout = Duration.fromInputUnsafe(options.idleTimeout ?? "60 minutes");
			const handover = Duration.fromInputUnsafe(options.handover ?? "30 seconds");

			const instances = new Map<string, Instance>();
			/** The space each running thread's events belong to. */
			const threads = new Map<string, string>();
			/** Last published event per `spaceId \0 type`. */
			const lastEvents = new Map<string, EventSchema.Payload>();

			const readable = (instance: Instance) =>
				instance.env === undefined ? Effect.succeed(false) : controller.held(instance.env);

			const io = (instance: Instance, space: Daemon.SpaceInfo, env: SandboxInstance.ID): Daemon.SpaceIO => ({
				attached: controller.held(env),
				use: (use, useOptions) => {
					const budget = Duration.fromInputUnsafe(useOptions?.budget ?? "20 seconds");
					return Effect.gen(function* () {
						const context = yield* Layer.build(controller.borrow(env, { cwd: space.location })).pipe(
							Effect.catchTag("SandboxNotHeldError", () =>
								Effect.fail(new Detached({ spaceId: instance.spaceId })),
							),
							Effect.catchTags({
								SandboxNotFoundError: Effect.die,
								SandboxDriverNotRegisteredError: Effect.die,
								SandboxUnavailError: Effect.die,
								SandboxRemovedError: Effect.die,
								SandboxProviderError: Effect.die,
							}),
						);
						return yield* use({
							fs: Context.get(context, SandboxIO.FileSystem),
							shell: Context.get(context, SandboxIO.Shell),
						});
					}).pipe(
						Effect.scoped,
						Effect.timeoutOrElse({
							duration: budget,
							orElse: () =>
								Effect.fail(new BudgetExceeded({ spaceId: instance.spaceId, budget: Duration.format(budget) })),
						}),
					);
				},
			});

			const context = (
				instance: Instance,
				running: Running,
				space: Daemon.SpaceInfo,
				env: SandboxInstance.ID,
				/** The daemon's own scope: a start that fails closes it, and its work with it. */
				scope: Scope.Scope,
			) => {
				const ctx: Daemon.SpaceContext = {
					plugin: { id: running.daemon.id, options: {} },
					space,
					io: io(instance, space, env),
					events: {
						on: (definitions, handler) =>
							Effect.gen(function* () {
								const types = (Array.isArray(definitions) ? definitions : [definitions]).map(
									(definition: EventSchema.Definition) => definition.type,
								);
								const entry = handler as Handler;
								for (const type of types)
									running.handlers.set(type, [...(running.handlers.get(type) ?? []), entry]);
								yield* Effect.addFinalizer(() =>
									Effect.sync(() => {
										for (const type of types)
											running.handlers.set(
												type,
												(running.handlers.get(type) ?? []).filter((item) => item !== entry),
											);
									}),
								);
							}),
						publish: (definition, data) =>
							Effect.gen(function* () {
								const observedAt = yield* Clock.currentTimeMillis;
								const full = { ...data, spaceId: instance.spaceId, observedAt };
								// Checked before it reaches the bus: an event the feed cannot encode disconnects every client.
								const valid = yield* Schema.encodeUnknownEffect(definition.data)(full).pipe(
									Effect.as(true),
									Effect.catchCause((cause) =>
										Effect.logWarning(
											`daemon ${running.daemon.id} published an invalid ${definition.type}`,
											cause,
										).pipe(Effect.as(false)),
									),
								);
								if (!valid) return;
								// Kept before it publishes, so a client subscribing meanwhile gets it from the replay if
								// not live; a copy received twice is the same value.
								const id = EventSchema.ID.create();
								lastEvents.set(`${instance.spaceId}\0${definition.type}`, {
									id,
									type: definition.type,
									data: full,
								});
								yield* events
									.publish(definition, full as never, { id })
									.pipe(
										Effect.catchCause((cause) =>
											Effect.logWarning(
												`daemon ${running.daemon.id} could not publish ${definition.type}`,
												cause,
											),
										),
									);
							}),
					},
					work: (name, run) =>
						Effect.gen(function* () {
							const work = yield* Work.make({
								name: `${running.daemon.id}/${name}`,
								scope,
								readable: readable(instance),
								run,
							});
							running.works.push(work);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									const index = running.works.indexOf(work);
									if (index !== -1) running.works.splice(index, 1);
								}),
							);
							return { mark: work.mark };
						}),
					handle: (method, handler) =>
						Effect.gen(function* () {
							running.methods.set(method, handler as MethodHandler);
							yield* Effect.addFinalizer(() => Effect.sync(() => running.methods.delete(method)));
						}),
				};
				return ctx;
			};

			const handle = (running: Running, event: EventSchema.Payload) =>
				Effect.forEach(running.handlers.get(event.type) ?? [], (handler) =>
					handler(event).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning(`daemon ${running.daemon.id} failed on ${event.type}`, cause),
						),
					),
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							running.pending -= 1;
						}),
					),
				);

			/** The space's folder and env, read once per instance. */
			const resolve = (instance: Instance) =>
				Effect.gen(function* () {
					if (instance.space !== undefined && instance.env !== undefined)
						return Option.some({ space: instance.space, env: instance.env });
					const rows = yield* sql<{ id: string; projectId: string; location: string; env: string | null }>`
						SELECT id, project_id, location, env FROM space WHERE id = ${instance.spaceId} AND status = 'active'
					`;
					const row = rows[0];
					if (row === undefined) return Option.none();
					const env = SandboxInstance.ID.make(row.env ?? SandboxInstance.ID.local);
					const driver =
						env === SandboxInstance.ID.local
							? undefined
							: (yield* controller.get(env)).pipe(
									Option.map((info) => info.driver),
									Option.getOrElse(() => "unknown"),
								);
					instance.env = env;
					instance.space = {
						id: row.id,
						projectId: row.projectId,
						location: row.location,
						placement: driver === undefined ? { kind: "local" } : { kind: "remote", driver },
					};
					return Option.some({ space: instance.space, env });
				}).pipe(Effect.orDie);

			/**
			 * Starts one daemon in its own scope under the instance's. One that does not start (no space,
			 * a failed or hung `start`) is taken out with its queue, so the next mount tries again.
			 */
			const startDaemon = (instance: Instance, running: Running) =>
				Effect.gen(function* () {
					const scope = Scope.forkUnsafe(instance.scope, "sequential");
					const started = yield* Effect.gen(function* () {
						const found = yield* resolve(instance);
						if (Option.isNone(found)) return false;
						yield* running.daemon
							.start(context(instance, running, found.value.space, found.value.env, scope) as never)
							.pipe(
								Scope.provide(scope),
								Effect.timeoutOrElse({
									duration: "30 seconds",
									orElse: () => Effect.fail(new DaemonStartTimeout({ daemon: running.daemon.id })),
								}),
							);
						return true;
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(
								`daemon ${running.daemon.id} failed to start in space ${instance.spaceId}`,
								cause,
							).pipe(Effect.as(false)),
						),
					);
					if (!started) {
						if (instance.plugins.get(running.daemon.id) === running) instance.plugins.delete(running.daemon.id);
						yield* Queue.shutdown(running.queue);
						return yield* Scope.close(scope, Exit.void);
					}
					running.started = true;
					yield* Queue.take(running.queue).pipe(
						Effect.flatMap((event) => handle(running, event)),
						Effect.forever,
						Effect.forkIn(scope),
					);
				});

			/** The space's instance, created synchronously so two first mounts cannot make two. */
			const ensure = (spaceId: string) =>
				Effect.gen(function* () {
					let instance = instances.get(spaceId);
					if (instance === undefined) {
						instance = {
							spaceId,
							scope: Scope.forkUnsafe(root, "parallel"),
							plugins: new Map(),
							space: undefined,
							env: undefined,
							idle: undefined,
						};
						instances.set(spaceId, instance);
					}
					const target = instance;
					for (const daemon of options.daemons) {
						if (target.plugins.has(daemon.id)) continue;
						const queue = yield* Queue.unbounded<EventSchema.Payload>();
						// Checked again: making the queue yielded, and another mount may have started it.
						if (target.plugins.has(daemon.id)) {
							yield* Queue.shutdown(queue);
							continue;
						}
						const running: Running = {
							daemon,
							queue,
							handlers: new Map(),
							methods: new Map(),
							works: [],
							started: false,
							pending: 0,
						};
						target.plugins.set(daemon.id, running);
						yield* startDaemon(target, running).pipe(Effect.forkIn(target.scope));
					}
					return target;
				});

			const deliver = (instance: Instance, event: EventSchema.Payload) =>
				Effect.forEach(
					instance.plugins.values(),
					(running) => {
						// Before its handlers exist, everything is queued; after, only what it subscribed to.
						if (running.started && !running.handlers.has(event.type)) return Effect.void;
						running.pending += 1;
						return Queue.offer(running.queue, event).pipe(Effect.asVoid);
					},
					{ discard: true },
				);

			const settled = (instance: Instance) =>
				Effect.gen(function* () {
					for (const running of instance.plugins.values()) {
						if (running.pending > 0) return false;
						for (const work of running.works) if (!(yield* work.settled)) return false;
					}
					return true;
				});

			const stop = (instance: Instance) =>
				Effect.gen(function* () {
					// Its last events stay: a client subscribing later still sees how the space was, and how long ago.
					instances.delete(instance.spaceId);
					yield* Scope.close(instance.scope, Exit.void);
				});

			const occupied = (spaceId: string) => [...threads.values()].includes(spaceId);

			const scheduleIdle = (instance: Instance): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (instance.idle !== undefined) yield* Fiber.interrupt(instance.idle);
					instance.idle = yield* Effect.sleep(idleTimeout).pipe(
						Effect.andThen(
							Effect.suspend(() => {
								instance.idle = undefined;
								if (occupied(instance.spaceId)) return Effect.void;
								// Pending work finishes first: it is waited for another idle period.
								return settled(instance).pipe(
									Effect.flatMap((done) => (done ? stop(instance) : scheduleIdle(instance))),
								);
							}),
						),
						Effect.forkIn(root),
					);
				});

			/**
			 * Keeps the sandbox borrowable after the drain lets go, while work is pending. Taken here,
			 * inside the publish of `detached`, while that drain's lease is still held.
			 */
			const openHandover = (instance: Instance) =>
				Effect.gen(function* () {
					const found = yield* resolve(instance);
					if (Option.isNone(found) || found.value.env === SandboxInstance.ID.local) return;
					const env = found.value.env;
					const scope = yield* Scope.fork(root, "sequential");
					const taken = yield* controller.hold(env).pipe(
						Scope.provide(scope),
						Effect.as(true),
						Effect.catchCause(() => Effect.succeed(false)),
					);
					if (!taken) return yield* Scope.close(scope, Exit.void);
					yield* Effect.gen(function* () {
						yield* Effect.sleep("50 millis");
						while (!(yield* settled(instance))) yield* Effect.sleep("100 millis");
					}).pipe(
						Effect.timeoutOrElse({ duration: handover, orElse: () => Effect.void }),
						Effect.ensuring(Scope.close(scope, Exit.void)),
						Effect.forkIn(root),
					);
				});

			const onEvent = (event: EventSchema.Payload): Effect.Effect<void> =>
				Effect.gen(function* () {
					if (event.type === EventList.SpaceMountAttached.type) {
						const data = event.data as EventList.SpaceMountAttached["data"];
						threads.set(data.threadId, data.spaceId);
						const instance = yield* ensure(data.spaceId);
						if (instance.idle !== undefined) {
							yield* Fiber.interrupt(instance.idle);
							instance.idle = undefined;
						}
						yield* deliver(instance, event);
						for (const running of instance.plugins.values()) for (const work of running.works) yield* work.wake;
						return;
					}
					if (event.type === EventList.SpaceMountDetached.type) {
						const data = event.data as EventList.SpaceMountDetached["data"];
						const instance = instances.get(data.spaceId);
						threads.delete(data.threadId);
						if (instance === undefined) return;
						yield* deliver(instance, event);
						if (!occupied(data.spaceId)) {
							yield* openHandover(instance);
							yield* scheduleIdle(instance);
						}
						return;
					}
					const threadId = threadOf(event);
					if (threadId === undefined) return;
					const spaceId = threads.get(threadId);
					if (spaceId === undefined) return;
					const instance = instances.get(spaceId);
					if (instance !== undefined) yield* deliver(instance, event);
				}).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logWarning("space daemon host failed on an event", cause),
					),
				);

			const unlisten = yield* events.listen(onEvent);
			yield* Effect.addFinalizer(() => unlisten);

			const call: Interface["call"] = (input) =>
				Effect.gen(function* () {
					const running = instances.get(input.spaceId)?.plugins.get(input.plugin);
					if (running === undefined || !running.started) {
						return yield* new DaemonCallError({
							reason: "unavailable",
							message: `No ${input.plugin} daemon is running in space ${input.spaceId}`,
						});
					}
					const method = running.daemon.methods?.[input.method];
					const handler = running.methods.get(input.method);
					if (method === undefined || handler === undefined) {
						return yield* new DaemonCallError({
							reason: "method_not_found",
							message: `The ${input.plugin} daemon has no method ${input.method}`,
						});
					}
					const decoded = yield* Schema.decodeEffect(method.input)(input.input ?? {}).pipe(
						Effect.mapError((error) => new DaemonCallError({ reason: "invalid_input", message: String(error) })),
					);
					const output = yield* handler(decoded).pipe(
						Effect.catchCause((cause) => {
							if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
							const error: unknown = Cause.squash(cause);
							if (isDetached(error))
								return Effect.fail(
									new DaemonCallError({
										reason: "detached",
										message: `Space ${input.spaceId} is not mounted`,
									}),
								);
							return Effect.fail(
								new DaemonCallError({
									reason: "failed",
									message: error instanceof Error ? error.message : String(error),
								}),
							);
						}),
					);
					return yield* Schema.encodeUnknownEffect(method.output)(output).pipe(
						Effect.mapError((error) => new DaemonCallError({ reason: "invalid_output", message: String(error) })),
					);
				});

			const last: Interface["last"] = (types) => [...lastEvents.values()].filter((event) => types.has(event.type));

			return Service.of({ call, last });
		}),
	);
