import { Context, Effect, Layer as EffectLayer } from "effect";
import { posix } from "node:path";
import type { SandboxDriver } from "./driver";
import { SandboxFileSystem } from "./fs/filesystem";
import { SandboxInstance } from "./instance";
import { type ISandboxExe, Shell as ShellTag, withCwd as shellWithCwd } from "./shell/shell";

/**
 * `SandboxIO` is a **mount**: a filesystem, a shell, and the identity and
 * working directory they act on.
 *
 * It is the whole vocabulary a consumer needs. Project, Git, Copy, Location, and
 * every tool ask for `SandboxIO.FileSystem`, `SandboxIO.Shell`, and
 * `SandboxIO.Current` — never for a driver, an address, or a provider SDK — so
 * a host directory, an in-memory VFS, and a remote microVM are interchangeable
 * behind one contract.
 *
 * The mount neither creates nor destroys infrastructure. `SandboxInstance` is
 * the durable namespace it acts on — a device, which exists whether or not
 * anything has it mounted — and `Sandbox.Controller` is the only path that
 * creates, stops, or destroys one.
 */

/**
 * The filesystem tag. Re-exported here so consumers import one namespace —
 * Project, Git, Copy, and the runner ask for `SandboxIO.FileSystem`, never for
 * the module that happens to define it. Code *inside* `sandbox/` keeps importing
 * the tag directly, since `io.ts` is built on top of it.
 */
export const FileSystem = SandboxFileSystem.Service;
export type FileSystem = SandboxFileSystem.Service;

/** The shell tag. Re-exported here so consumers import one namespace. */
export const Shell = ShellTag;
export type Shell = ShellTag;

/**
 * What a mount sees: immutable identity, plus the working directory resolved for
 * *this* mount.
 *
 * Nothing mutable belongs here. `status`, `usage`, and reference counts all
 * change while a mount is open, so a mount-time snapshot of them would be wrong
 * by construction — runtime code that needs live management state asks the
 * control plane. The driver's own resource locator is likewise absent: consumers
 * never parse a Vercel name or a Daytona id.
 */
export interface Identity {
	readonly id: SandboxInstance.ID;
	readonly driver: SandboxDriver.Name;
	readonly kind: SandboxInstance.Kind;
	/** Absolute, and always a path in *this* namespace. */
	readonly cwd: string;
}

/** Identity and working directory of the current mount. */
export class Current extends Context.Service<Current, Identity>()("@codework/sandbox/io/current") {}

/** Everything a mount provides. */
export type Provides = Current | SandboxFileSystem.Service | ShellTag;

/** A built mount. */
export type Layer<E = never, RIn = never> = EffectLayer.Layer<Provides, E, RIn>;

/**
 * Resolve a mount's cwd without consulting ambient process state.
 *
 * The default is supplied by the namespace adapter:
 * provider metadata remotely, `/` for a virtual filesystem, and `process.cwd()` for the host adapter.
 * An explicit absolute cwd replaces it; a relative cwd is resolved inside it. The
 * result is therefore always the one concrete absolute path `Current` requires.
 *
 * A non-absolute default throws rather than failing typed. It is the one
 * defect-level guard in this module, and deliberately so:
 * Adapters reading a value from a provider call this inside their own error channel,
 * where the throw becomes their typed failure (see `EnvDaytona.mountCwd`).
 */
export const resolveMountCwd = (defaultCwd: string, cwd?: string): string => {
	if (!posix.isAbsolute(defaultCwd)) {
		throw new TypeError(`Sandbox default cwd must be absolute: ${defaultCwd}`);
	}
	// `resolve`, not `normalize`: normalize keeps a trailing slash, and `cwd` is
	// persisted — `Location.directory` and `project_directory`'s hash would read
	// `/workspace/` and `/workspace` as two directories and keep a row for each.
	//
	// A provider-reported default (`getWorkDir()`) or a config value is free to
	// carry one, so it is stripped here rather than at every reader.
	if (cwd === undefined) return posix.resolve(defaultCwd);
	return posix.isAbsolute(cwd) ? posix.resolve(cwd) : posix.resolve(defaultCwd, cwd);
};

/**
 * Bind a cwd-neutral transport to one mount.
 *
 * The transport underneath is shared between
 * mounts and stays rooted at the namespace root, and everything directory-shaped
 * happens here, once per mount. Two mounts of one namespace at different working
 * directories therefore coexist without seeing or moving each other's.
 *
 * It consumes the same two tags it provides — the transport is supplied by the
 * layer this is composed over, not by itself.
 */
export const mount = (identity: Identity): EffectLayer.Layer<Provides, never, SandboxFileSystem.Service | ShellTag> =>
	EffectLayer.mergeAll(
		EffectLayer.succeed(Current, identity),
		EffectLayer.effect(
			SandboxFileSystem.Service,
			Effect.map(SandboxFileSystem.Service, (fs) => SandboxFileSystem.withCwd(fs, identity.cwd)),
		),
		EffectLayer.effect(
			ShellTag,
			Effect.map(ShellTag, (shell: ISandboxExe) => shellWithCwd(shell, identity.cwd)),
		),
	);

/**
 * Just the identity tag, with no filesystem or shell beneath it. For consumers
 * assembled from stubs — a test that runs `Project` over a fake filesystem still
 * needs to know which namespace it is in.
 */
export const identityLayer = (identity: Identity) => EffectLayer.succeed(Current, identity);

/** The host identity alone. See {@link identityLayer}. */
export const hostLayer = (cwd?: string) => identityLayer(host(cwd));

/**
 * The host, rooted at `cwd`. Always `SandboxInstance.ID.local`: the working
 * directory selects where relative paths resolve, it does not make a second host
 * namespace — two mounts rooted at different directories still agree on absolute
 * paths.
 *
 * The host adapter defaults to `process.cwd()`, matching the OS process it wraps.
 * This is the one namespace where that coordinate is intrinsically valid; remote
 * and virtual adapters must never inherit it.
 */
export const host = (cwd?: string): Identity => ({
	id: SandboxInstance.ID.local,
	driver: "local" as SandboxDriver.Name,
	kind: "local",
	cwd: resolveMountCwd(process.cwd(), cwd),
});

/**
 * A VFS-backed namespace. The id is minted per call unless one is named, because
 * building one of these builds a fresh VFS: N unnamed calls are N distinct
 * namespaces, none of which outlives the process. A file-backed store is the
 * exception — its file is the state, so whoever knows the file supplies the id
 * it was registered under.
 */
export const virtual = (input: {
	readonly driver: string;
	readonly id?: SandboxInstance.ID;
	readonly defaultCwd?: string;
	readonly cwd?: string;
}): Identity => ({
	id: input.id ?? SandboxInstance.ID.create(),
	driver: input.driver as SandboxDriver.Name,
	kind: "virtual",
	cwd: resolveMountCwd(input.defaultCwd ?? "/", input.cwd),
});

/**
 * A provider-hosted namespace. The id is always supplied: a remote resource's
 * durable identity is minted and recorded by whoever provisioned it, never
 * derived here from the provider's own locator.
 */
export const remote = (input: {
	readonly driver: string;
	readonly id: SandboxInstance.ID;
	/** Namespace-intrinsic default supplied or discovered by the driver. */
	readonly defaultCwd: string;
	readonly cwd?: string;
}): Identity => ({
	id: input.id,
	driver: input.driver as SandboxDriver.Name,
	kind: "remote",
	cwd: resolveMountCwd(input.defaultCwd, input.cwd),
});

export * as SandboxIO from "./io";
