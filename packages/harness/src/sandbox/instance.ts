import { Context, type Layer as EffectLayer, Layer, Option, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "../schema";
import type { SandboxFileSystem } from "./filesystem/filesystem";
import type { Shell } from "./shell";

/**
 * A Sandbox instance is a **durable filesystem namespace** plus whatever compute
 * acts on it — a device in Unix terms, which exists whether or not anything has
 * it mounted. `Sandbox.Controller` (added later) is the only thing that creates,
 * stops, or destroys one; this module is just its identity and state model.
 *
 * The application ID is deliberately separate from the driver's own resource
 * locator: callers never parse a Vercel name or a Daytona id, driver formats may
 * change, and a destroyed resource must stay identifiable in Project/Session
 * history. A missing resource is never recreated under an existing ID — a new
 * resource is a new namespace and therefore a new ID.
 */

export const ID = Schema.String.pipe(
	Schema.brand("SandboxInstance.ID"),
	withStatics((schema) => ({
		/**
		 * The host. Reserved, and never written to a column — see {@link toColumn}.
		 * It exists at runtime so nothing has to branch on "is this the host": it is
		 * what identity reads, what logs show, and what the transport cache keys on.
		 */
		local: schema.make("local"),
		/** A fresh identity for a namespace nothing has named yet. */
		create: () => schema.make(`sbx_${uuidv7()}`),
	})),
);
export type ID = typeof ID.Type;

/**
 * The storage boundary for namespace references, in one place.
 *
 * The host filesystem exists whether or not a row describes it, so it gets no
 * row and `NULL` is the only spelling of it — the Unix analogue is exact, since
 * `/` has no entry in the mount table you consult to find other mounts. That
 * makes a session or directory writable before any namespace is registered (the
 * foreign key is skipped on NULL), makes `SET sandbox_instance_id = NULL` a
 * meaningful "revert to the host", and leaves the host impossible to tombstone,
 * collect, or destroy, because there is nothing to point at.
 *
 * Two SQLite consequences ride on this and break correctness silently if missed:
 * unique indexes treat NULLs as distinct, so every uniqueness constraint
 * spanning a namespace column coalesces to `'local'`; and `= NULL` never
 * matches, so namespace-scoped reads use `IS`.
 */
export const toColumn = (id: ID): string | null => (id === ID.local ? null : id);
export const fromColumn = (value: string | null): ID => (value === null ? ID.local : ID.make(value));

/**
 * The same mapping for row models, whose optional columns are `Option` rather
 * than `null`. Kept beside {@link toColumn} so the boundary stays one place:
 * `toColumn`/`fromColumn` for SQL parameters, these for `Model.FieldOption`.
 */
export const toField = (id: ID): Option.Option<ID> => (id === ID.local ? Option.none() : Option.some(id));
export const fromField = (value: Option.Option<ID>): ID => Option.getOrElse(value, () => ID.local);

/**
 * Filesystem-class taxonomy, mirroring Unix: disk, tmpfs/procfs, NFS/CIFS.
 * Stored on the row rather than derived from the registered driver, so reading
 * an instance never depends on the registry — which matters most when a driver
 * is *not* configured and you need to list or clean up its rows.
 */
export const Kind = Schema.Literals(["local", "virtual", "remote"]);
export type Kind = typeof Kind.Type;

export const Ownership = Schema.Literals(["managed", "external"]);
export type Ownership = typeof Ownership.Type;

/**
 * Lifecycle state, in ZFS pool vocabulary. This is the **last observed** value,
 * not live driver truth: Daytona auto-stops and auto-archives, Vercel sandboxes
 * expire on their own timeout, so drift is normal. `stateObservedAt` carries the
 * freshness and `Controller.refresh` updates it without waking anything.
 *
 * `removed` and `unavail` are deliberately distinct. `removed` means we deleted
 * it; `unavail` means the driver claims it is gone. A "not found" is frequently a
 * misclassification — wrong region, wrong API url, a revoked key answering 404,
 * eventual consistency right after create — so it must never be recorded as if we
 * had destroyed the resource ourselves.
 */
export const Status = Schema.Literals([
	"provisioning",
	"online",
	"offline",
	"suspending",
	"removing",
	"removed",
	"unavail",
	"faulted",
]);
export type Status = typeof Status.Type;

/**
 * The statuses a `mount` may proceed from. This is the predicate every
 * conditional write depends on, so it is enumerated once here rather than
 * restated as prose at each call site.
 *
 * `offline` qualifies because mounting wakes. `faulted` qualifies because a
 * fault is a *usability* condition, not an identity one — see {@link Status}.
 *
 * There is no `resuming`: it would exist to be observed by nothing, since
 * mounting wakes, `offline` is already mountable, and waking is not destructive
 * so it needs no claim. `suspending` and `removing` stay because they *are*
 * compare-and-set claims, blocking a concurrent mount mid-destruction.
 */
export const mountable: ReadonlySet<Status> = new Set<Status>(["online", "offline", "faulted"]);

export const isMountable = (status: Status): boolean => mountable.has(status);

/**
 * Reference state, derived — never stored. `busy` carries its `umount` meaning:
 * something holds this and destruction must not proceed unforced.
 *
 * `pinned` is the kernel sense of the word: never reclaimable. It short-circuits
 * counting entirely for instances that cannot be stopped or destroyed (the local
 * host), which is what keeps them out of any future collector by construction
 * rather than by an ownership check happening to catch them.
 */
export const Usage = Schema.Literals(["idle", "busy", "pinned"]);
export type Usage = typeof Usage.Type;

/** Sanitized driver failure. The only error shape allowed to be persisted or logged. */
export const PersistedError = Schema.Struct({
	name: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
});
export type PersistedError = typeof PersistedError.Type;

/**
 * What a mount sees: immutable identity, plus the cwd resolved for this mount.
 * Nothing mutable belongs here — `status`, `usage`, and reference counts all
 * change while a mount is open, so a mount-time snapshot of them would be wrong
 * by construction. Runtime code that needs live management state asks the
 * control plane.
 */
export interface RuntimeIdentity {
	readonly id: ID;
	readonly driver: string;
	readonly kind: Kind;
	readonly cwd: string;
}

/** Durable metadata, safe to return and persist. Assembled by the Controller. */
export interface Info {
	readonly id: ID;
	readonly driver: string;
	readonly kind: Kind;
	readonly providerResourceId: Option.Option<string>;
	readonly ownership: Ownership;
	readonly status: Status;
	readonly usage: Usage;
	/** References held by *this* control plane. Process-local; see the transport cache. */
	readonly refCount: number;
	readonly providerStatus: Option.Option<string>;
	readonly metadata: Readonly<Record<string, string>>;
	readonly lastError: Option.Option<PersistedError>;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly stateObservedAt: Date;
	readonly lastMountedAt: Option.Option<Date>;
	readonly lastUnmountedAt: Option.Option<Date>;
	readonly lastUsedAt: Option.Option<Date>;
	readonly removedAt: Option.Option<Date>;
}

/** Identity of the instance the current runtime services act on. */
export class Service extends Context.Service<Service, RuntimeIdentity>()("@codework/sandbox/instance") {}

export const layer = (identity: RuntimeIdentity) => Layer.succeed(Service, identity);

/**
 * The host namespace, rooted at `cwd`. Always {@link ID.local}: `cwd` selects
 * where relative paths resolve, it does not make a second host filesystem — two
 * mounts rooted at different directories still agree on absolute paths.
 *
 * The default is the namespace root, never `process.cwd()`. A default has to be a
 * fact about the namespace rather than about the process: `/` exists in every
 * namespace, while a host path used in a remote one is a coordinate from another
 * coordinate system, and it fails silently rather than loudly. Callers wanting
 * the process directory read it at the edge, where the namespace *is* the host,
 * and pass it in.
 */
export const host = (cwd = "/"): RuntimeIdentity => ({ id: ID.local, driver: "local", kind: "local", cwd });

/** The host identity as a Layer, for consumers assembled without a full mount. */
export const hostLayer = (cwd = "/") => layer(host(cwd));

/**
 * A VFS-backed namespace. `id` is minted per build unless the caller names one,
 * because building one of these builds a fresh VFS: N unnamed calls are N
 * distinct namespaces, and none of them outlives the process that made it. A
 * file-backed store is the exception — its file is the state, so whoever knows
 * the file supplies the ID it was registered under.
 */
export const virtual = (input: {
	readonly driver: string;
	readonly id?: ID;
	readonly cwd?: string;
}): RuntimeIdentity => ({
	id: input.id ?? ID.create(),
	driver: input.driver,
	kind: "virtual",
	cwd: input.cwd ?? "/",
});

/**
 * A provider-hosted namespace. The ID is always supplied: a remote resource's
 * durable identity is minted and recorded by whoever provisioned it, never
 * derived here from the provider's own locator.
 */
export const remote = (input: {
	readonly driver: string;
	readonly id: ID;
	readonly cwd?: string;
}): RuntimeIdentity => ({
	id: input.id,
	driver: input.driver,
	kind: "remote",
	cwd: input.cwd ?? "/",
});

/** Everything an acquired runtime provides. */
export type Provides = Service | SandboxFileSystem.Service | Shell;

/** A built runtime: identity plus the pluggable IO boundary. */
export type RuntimeLayer<E = never, RIn = never> = EffectLayer.Layer<Provides, E, RIn>;

export * as SandboxInstance from "./instance";
