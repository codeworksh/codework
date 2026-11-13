/**
 * Daemon plugins: long-running workers the harness starts per scope, instead of setting up per turn.
 *
 * Only the `space` scope exists today. A space daemon has one instance per space (one folder in one
 * env), started on the first drain that mounts the space and stopped after it has been idle. It
 * reacts to what runs in the space, reads the space through I/O it can only borrow while something
 * else holds the sandbox, and publishes what it found as its own events.
 */
import type { Duration, Effect, Schema, Scope } from "effect";
import { Schema as S } from "effect";
import type { Data, Definition, Payload } from "../event.ts";
import type { Interface as FileSystem } from "../sandbox/filesystem.ts";
import type { ISandboxExe as Shell } from "../sandbox/shell.ts";
import type { PluginOptions } from "./ref.ts";

/** The space has no lease held: reading it would wake a sandbox, so the read is refused. */
export class Detached extends S.TaggedError<Detached>()("Daemon.Detached", {
	spaceId: S.String,
}) {}

/** A borrowed read ran past its budget and was cut off. */
export class BudgetExceeded extends S.TaggedError<BudgetExceeded>()("Daemon.BudgetExceeded", {
	spaceId: S.String,
	budget: S.String,
}) {}

/** How a daemon's own code may fail: a tagged error or an `Error`. */
export type Failure = Error | { readonly _tag: string };

export interface SpaceInfo {
	/** `hash(env, location)`. */
	readonly id: string;
	readonly projectId: string;
	/** The space's folder: every borrowed read runs relative to it. */
	readonly location: string;
	readonly placement: { readonly kind: "local" } | { readonly kind: "remote"; readonly driver: string };
}

export interface SpaceIO {
	/** Whether a read right now would be allowed. */
	readonly attached: Effect.Effect<boolean>;
	/**
	 * Runs `use` with the space's filesystem and shell. Never wakes a sandbox: it fails with
	 * {@link Detached} unless a drain holds the sandbox or the harness opened a handover after one,
	 * and it is cut off with {@link BudgetExceeded} after `budget` (default 20 seconds).
	 */
	readonly use: <A, E>(
		use: (io: { readonly fs: FileSystem; readonly shell: Shell }) => Effect.Effect<A, E>,
		options?: { readonly budget?: Duration.Input },
	) => Effect.Effect<A, E | Detached | BudgetExceeded>;
}

/** A single-flight job with a dirty flag, created by {@link SpaceContext.work}. */
export interface Work {
	/**
	 * Ask for a run. Runs now when idle and the space is readable, once more after the current run
	 * when one is in flight (any number of marks make one rerun), and on the space's next mount when
	 * it is not readable.
	 */
	readonly mark: Effect.Effect<void>;
}

/** A method clients call through `daemon.call`: its input and output, validated by the harness. */
export interface Method<
	I extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
	O extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> {
	readonly input: I;
	readonly output: O;
}

export type Methods = Readonly<Record<string, Method>>;

export interface SpaceContext<M extends Methods = Methods> {
	readonly plugin: { readonly id: string; readonly options: PluginOptions };
	readonly space: SpaceInfo;
	readonly io: SpaceIO;
	readonly events: {
		/**
		 * Mount events of this space (`space.mount.attached`, `space.mount.detached`) and the session
		 * events of threads while they run here. Handlers run one at a time per daemon; the
		 * subscription ends with the instance.
		 */
		readonly on: <D extends Definition>(
			definitions: D | ReadonlyArray<D>,
			handler: (event: Payload<D>) => Effect.Effect<void>,
		) => Effect.Effect<void, never, Scope.Scope>;
		/**
		 * One of the plugin's own `events`. The harness fills `spaceId` and `observedAt`, keeps the
		 * event as this space's last of its type (replayed to clients that subscribe later), and drops
		 * one that does not encode.
		 */
		readonly publish: <D extends Definition>(
			definition: D,
			data: Omit<Data<D>, "spaceId" | "observedAt">,
		) => Effect.Effect<void>;
	};
	/** A single-flight job for `run`; runs in the instance's scope and stops with it. */
	readonly work: <E>(name: string, run: Effect.Effect<void, E>) => Effect.Effect<Work, never, Scope.Scope>;
	/** The handler for one of the plugin's declared `methods`. */
	readonly handle: <K extends keyof M & string, E>(
		method: K,
		handler: (input: Schema.Schema.Type<M[K]["input"]>) => Effect.Effect<Schema.Schema.Type<M[K]["output"]>, E>,
	) => Effect.Effect<void, never, Scope.Scope>;
}

export interface DaemonPlugin<M extends Methods = Methods> {
	readonly id: string;
	readonly kind: "daemon";
	readonly scope: "space";
	/**
	 * Events this daemon publishes, namespaced `plugin.<id>.*`. Each carries `spaceId` and
	 * `observedAt`, which the harness fills.
	 */
	readonly events?: ReadonlyArray<Definition>;
	/** Methods clients call through `daemon.call`. */
	readonly methods?: M;
	/**
	 * Runs once per instance: registers subscriptions, work and handlers, then returns. The instance
	 * keeps running until its scope closes.
	 */
	readonly start: (ctx: SpaceContext<M>) => Effect.Effect<void, Failure, Scope.Scope>;
}

export const define = <M extends Methods>(daemon: DaemonPlugin<M>): DaemonPlugin<M> => daemon;
