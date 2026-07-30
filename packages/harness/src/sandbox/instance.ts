import { Option, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "../schema";

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

/** Durable metadata, safe to return and persist. Assembled by the control plane. */
export interface Info {
	readonly id: ID;
	readonly driver: import("./driver").Name;
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

export * as SandboxInstance from "./instance";
