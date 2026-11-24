# Sandboxes

A sandbox is where tools act: a filesystem, a shell and an identity. Project, Git, Location and every tool depend on those services and nothing else. They never ask for a driver, an address or a provider SDK, so the host, an in-memory filesystem and a remote microVM are interchangeable. The contract lives in [packages/plugin/src/sandbox](../../packages/plugin/src/sandbox/io.ts); the harness assembles it in [sandbox.ts](../../packages/harness/src/sandbox/sandbox.ts) and manages instances in [control.ts](../../packages/harness/src/sandbox/control.ts).

## The Contract

`SandboxIO` is a mount: `FileSystem`, `Shell`, `Mutation` (per-file write ordering) and `Current`, the identity and cwd they act on.

The identity is part of the contract because anything persisted about a sandbox has to be scoped to it. `/workspace` in two sandboxes is two different trees with the same spelling. A path means nothing without its env.

`Current` holds nothing mutable. Status, usage and reference counts change while a mount is open, so a snapshot of them would be wrong by construction. Code that needs live state asks the controller.

## Env Ids

An instance id is ours (`sbx_…`), separate from the provider's resource id ([instance.ts](../../packages/plugin/src/sandbox/instance.ts)). Callers never parse a provider's name format, the format may change, and a destroyed resource must stay identifiable in project and session history. A missing resource is never recreated under an existing id: a new resource is a new namespace and gets a new id.

The host is the reserved id `local` and never has a row. Its column spelling is `NULL`:

- a session or space is writable before any sandbox is registered,
- the host cannot be tombstoned, collected or destroyed, because there is nothing to point at,
- unique indexes over an env column must coalesce to `'local'`, since SQLite treats NULLs as distinct,
- env-scoped reads must use `IS`, since `= NULL` never matches.

Always convert with `toColumn`/`fromColumn` (or `toField`/`fromField` for row models). Never write `local` to a column.

## Kinds

| Kind    | What it is                                                    |
| ------- | ------------------------------------------------------------- |
| local   | The host. Only the host; a driver cannot declare it.          |
| virtual | In-process filesystem with a just-bash shell (memory, sqldb). |
| remote  | A provider's machine (Vercel, Daytona).                       |

The kind is stored on the row instead of being read from the registered driver. Listing and cleaning up rows then works even when their driver is not configured. Boot fails if a registered driver's kind conflicts with rows already persisted under its name.

## Ownership

A `managed` sandbox is one CodeWork created through the controller. An `external` one is an existing provider resource attached with `register`, which needs the driver's reattach capability. The host reports itself as external and `pinned`.

`stop` and `destroy` refuse anything that is not managed. `register` is idempotent for the same resource and runtime config, and refuses a resource that is already registered as managed.

On shutdown, `codework serve` first interrupts active runs so their leases are released, then stops (never destroys) every managed sandbox ([server.ts](../../packages/codework/src/server/server.ts)). Each step is bounded by a timeout so a provider cannot hold the process open. An interrupted stop is recorded as `faulted` and recovers at the next mount. An in-process `codework run` stops the sandbox it created when it exits.

## Lifecycle State Is Last Observed

`status` is the last value CodeWork observed, not live provider truth. Providers auto-stop, archive and expire sandboxes on their own, so drift is normal. `stateObservedAt` says how fresh the value is, and `refresh` inspects without waking anything.

Changes made outside CodeWork, such as a stop in a provider's console, are not tracked at runtime. The row is corrected only when CodeWork next talks to the provider: a mount, refresh, wake or stop.

Rules that are easy to break:

- **`unavail` is not `removed`.** `removed` means we deleted it. A provider "not found" is often a misclassification (wrong region or API url, a revoked key answering 404, eventual consistency after create), so it is recorded as `unavail` and never as if we had destroyed it.
- **Mounting wakes.** `offline` and `faulted` are mountable; a fault is a usability condition, not an identity one.
- **A stale `online` gets one retry.** A persisted `online` can outlive a provider session URL. The mount drops the cached transport and attaches once more before recording a fault. It never creates a replacement.
- **Destroy needs a stop first.** Only `offline` and `unavail` sandboxes can be destroyed, and the tombstone archives the env's spaces in the same transaction.
- **Interrupted creation is visible.** At boot, rows stuck in `provisioning` past a cutoff become `faulted`.

## Mounts and Leases

A mount takes a lease. Leases are counted per process, and `stop` refuses a sandbox with any open (destroy needs `force`). Attached transports are cached per instance and dropped after an idle period.

`borrow` gives I/O without a lease, and only while a drain holds the sandbox or a `hold` is open. It never attaches or wakes anything, which is what lets space daemons read between runs without keeping a remote sandbox up. A hold never blocks `stop`.

A mount's cwd is absolute, or relative to the driver's default cwd. The host's default cwd is the `hostCwd` the harness was built with, never ambient `process.cwd()`.

## Drivers

A driver ([driver.ts](../../packages/plugin/src/sandbox/driver.ts)) must implement `create` and `attach`. `inspect`, `wake`, `stop`, `destroy` and reattach are optional and declared as capabilities. The [registry](../../packages/harness/src/sandbox/registry.ts) rejects a driver whose capability flags disagree with its implementation, `destroy` without `stop`, duplicate names, and the reserved names (`local`, `memory`, `sqldb`, `vercel`, `daytona`) from anything but a core or built-in source.

A loadable driver package default-exports `SandboxDriver.module` with an API version, a name, an options schema and a factory. The [loader](../../packages/harness/src/sandbox/loader.ts) accepts npm package specifiers only and resolves them against `hostCwd`: a driver package lives on the host no matter which namespace it serves. It checks the API version, decodes the options, and requires the factory's driver name to match the module's.

Drivers reach the harness through `Harness.Options.sandboxes` ([harness.ts](../../packages/harness/src/effect/harness.ts)), not through settings plugins. `memory` and `sqldb` are always registered as core. The CLI adds Daytona and Vercel ([cli/harness.ts](../../packages/codework/src/cli/harness.ts)).

[extras/codework-sandbox-vercel](../../extras/codework-sandbox-vercel/src/index.ts) is the reference for third parties. It uses only the public SDK in `@codeworksh/plugin/sandbox` and a non-reserved name. Compare it with the built-in driver in [sandboxes/vercel](../../packages/harness/src/sandboxes/vercel/index.ts) when a change to one should reach the other.
