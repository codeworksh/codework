import { Context, type Layer as EffectLayer, type Option, Schema } from "effect";
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
		/** The configured host. Deterministic, seeded by the initial migration. */
		local: schema.make("local"),
	})),
);
export type ID = typeof ID.Type;

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
	"resuming",
	"suspending",
	"removing",
	"removed",
	"unavail",
	"faulted",
]);
export type Status = typeof Status.Type;

/**
 * The statuses an `acquire` may proceed from. This is the predicate every
 * conditional write depends on, so it is enumerated once here rather than
 * restated as prose at each call site.
 *
 * `offline` qualifies because acquisition wakes. `faulted` qualifies because a
 * fault is a *usability* condition, not an identity one — see {@link Status}.
 */
export const acquirable: ReadonlySet<Status> = new Set<Status>(["online", "offline", "faulted"]);

export const isAcquirable = (status: Status): boolean => acquirable.has(status);

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
 * A reconstructible namespace's canonical row.
 *
 * The row for such a namespace is a **cache**, not durable truth. The host
 * filesystem exists whether or not a row describes it, so the row can be
 * re-asserted from configuration at any time — and must be, because nothing else
 * remembers it. Contrast a remote instance, whose row is the *only* record that
 * provider-side infrastructure exists at all; losing that row orphans billable
 * compute, which is why only remote creation needs labels and compensating
 * destruction.
 *
 * Reconstructible is exactly `kind !== "remote"`, so this needs no extra column.
 */
export interface Fixture {
	readonly id: ID;
	readonly driver: string;
	readonly kind: Kind;
	readonly ownership: Ownership;
	readonly status: Status;
	readonly runtimeConfig: string;
}

/**
 * The configured host. `external` because the host is not ours to destroy, and
 * `online` because it is always reachable — local has no stop or destroy, so its
 * lifecycle never legitimately moves and re-asserting the status is a repair
 * rather than an overwrite.
 */
export const localFixture: Fixture = {
	id: ID.local,
	driver: "local",
	kind: "local",
	ownership: "external",
	status: "online",
	runtimeConfig: "{}",
};

/**
 * What an acquired scope sees: immutable identity, plus the cwd resolved for this
 * acquisition. Nothing mutable belongs here — `status`, `usage`, and reference
 * counts all change while a scope is open, so an acquire-time snapshot of them
 * would be wrong by construction. Runtime code that needs live management state
 * asks the Controller.
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
	/** References held by *this* Controller. Process-local; see the runtime cache. */
	readonly refCount: number;
	readonly providerStatus: Option.Option<string>;
	readonly metadata: Readonly<Record<string, string>>;
	readonly lastError: Option.Option<PersistedError>;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly stateObservedAt: Date;
	readonly lastAcquiredAt: Option.Option<Date>;
	readonly lastReleasedAt: Option.Option<Date>;
	readonly lastUsedAt: Option.Option<Date>;
	readonly removedAt: Option.Option<Date>;
}

/** Identity of the instance the current runtime services act on. */
export class Service extends Context.Service<Service, RuntimeIdentity>()("@codework/sandbox/instance") {}

/** Everything an acquired runtime provides. */
export type Provides = Service | SandboxFileSystem.Service | Shell;

/** A built runtime: identity plus the pluggable IO boundary. */
export type RuntimeLayer<E = never, RIn = never> = EffectLayer.Layer<Provides, E, RIn>;

export * as SandboxInstance from "./instance";
