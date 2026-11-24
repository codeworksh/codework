# Services

The harness, the host (`packages/codework`) and the app server are written in Effect. `aikit` and Electron main are not. This page holds the rules for Effect code, taken from how the harness and the host already do it. When this page and the code disagree, the code wins and this page gets fixed.

## Shape of a Service Module

One module per service, named for its domain. It exports a tag class named `Service`, its `Interface`, and a `layer` (or `layer(options)` when it takes configuration). Consumers import the module as a namespace and say `Event.Service` and `Event.layer`. The harness re-exports its modules as namespaces from [effect.ts](../../packages/harness/src/effect.ts), and code outside the package imports from `@codeworksh/harness/effect`.

```ts
export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/identity/Service") {}
```

The id string is `@codeworksh/<package>/<path under src>/<Name>`, where the package is the npm name's last part: `harness`, `plugin`, `cli` for `packages/codework`, `server` for `apps/server`. The context looks a service up by this string, so it must be unique and must not change when nothing moved. When a file moves, its id moves with it.

Dependencies come from the context with `yield* Other.Service` inside the layer, so the layer's type shows what it needs. Options such as paths and timings are parameters to `layer(options)`; services are not. `Context.Reference` is for a value with a default that a caller may scope, like the write transaction's revision in [store.ts](../../packages/harness/src/db/store.ts).

Not every operation is a method. Many domains export plain `Effect.fn` functions that read services from the context, like `Project.rename`. A tag earns its place when it holds state: fibers, connections, caches, a subscription registry.

## Naming Effect Functions

Reusable functions use `Effect.fn("Module.operation")`. `Module` is the namespace consumers use (`Control.prompt`, `Settings.load`, `Project.rename`), and CLI handlers use `CLI.<command>` (`CLI.thread.list`). The name becomes the span name, so it is telemetry vocabulary; keep it stable. Keep `Effect.gen` for inline programs and layer construction.

```ts
export const resolve = Effect.fn("Global.resolve")(function* (input: Partial<Interface> = {}) {
	const home = input.home === undefined ? yield* homeConfig : expandHome(input.home);
	return make({ ...input, home });
});
```

RPC handlers use `Effect.fnUntraced`, because the RPC server already opens a span per request. That request span has no level, so it is Debug and drops every Info span beneath it. Work worth exporting from a handler starts its own root span, as `exported` in [handlers.ts](../../packages/codework/src/server/handlers.ts) does for sandbox provisioning. Span levels and export are covered in [telemetry](./12_telemetry.md).

## Layer Composition

`Harness.layer(options)` in [harness.ts](../../packages/harness/src/effect/harness.ts) is the core's single composition root. Every host provides it once: `serve`, in-process `run` and `acp`. A host never assembles its own partial harness. The root reads settings directly only to choose plugins, at boot and again on a plugin reload; everything else reads them through `Settings.Service`.

The host stacks its own layers on top, and order is behavior. In [server.ts](../../packages/codework/src/server/server.ts), anything that must finish before a client connects is provided below the listener. The idioms used there:

- `Layer.effectDiscard` for startup work with no service, such as `sweep`. A long task inside it is forked with `Effect.forkScoped`, as `resumeUnfinished` is, so it stops with the server.
- `Layer.unwrap` for a layer that depends on an effect or config, such as the listener's registration once it has an address.
- `Effect.addFinalizer` inside a layer for shutdown work tied to the layer's scope.

## Errors

- **Typed or defect.** A typed error is a failure a caller can act on. `PromptConflictError` is typed so a client that reused an id can react; an outdated database is typed because it is the user's to delete. A broken invariant is a defect: `Effect.die` or `Effect.orDie`.
- **Exported errors** are `Schema.TaggedError` classes with structured fields. Some tags are bare (`ProjectNotFoundError`, `SandboxBusyError`); others carry their module as a prefix (`Runner.ProviderError`, `Mcp.ConnectError`, `Server.HostError`, `CLI.InvalidInputError`). Follow the module you are in, and never rename an existing tag to make it consistent.
- **Private signals** that never leave their module use an unexported `Data.TaggedError`, like `Lock.Held` in [lock.ts](../../packages/harness/src/util/lock.ts).
- **Wire format.** The RPC contract's error unions include harness error classes. Renaming a tag or field there breaks the app's mirror of the contract and every older client.
- **Presentation stays in each package.** Harness errors carry facts. The CLI renders them in its own words and hints in [error.ts](../../packages/codework/src/cli/error.ts); the server and the app have their own vocabularies. Do not share message formatting across packages.

## Thin Transport Handlers

An RPC handler in [handlers.ts](../../packages/codework/src/server/handlers.ts) resolves its references, calls one harness operation, and maps harness types to contract types with the `to*` mappers there. A CLI handler in [handlers](../../packages/codework/src/cli/cmd/handlers) validates flag combinations, picks in-process or `--server`, and renders.

The reason is reach. ACP and in-process `run` boot the harness without the RPC layer, so logic written into an RPC handler is missing from both. When a handler grows past decode, call and map, move the logic into the harness.

CLI handlers are loaded with dynamic imports ([runtime.ts](../../packages/codework/src/framework/runtime.ts)), so starting the binary or printing `--help` never loads the harness. A handler module must not be imported eagerly.

## Where Plain Code Is Allowed

Effect is the default. Plain code is allowed in three places:

- **Sync Node hooks.** Module resolution hooks cannot yield, so [module.ts](../../packages/harness/src/util/module.ts) uses `node:fs` directly.
- **Pre-runtime startup.** [sea.ts](../../packages/codework/src/sea.ts) runs before the CLI and any Effect runtime exists, so it reads `process.env` and the filesystem directly.
- **Existing Promise contracts.** `aikit`, plugin `setup` (which may return nothing, a Promise or an Effect), the sandbox provider SDKs, the virtual filesystem and shell adapters, ACP and MCP. Each is wrapped at one boundary: [llm.ts](../../packages/harness/src/runner/llm.ts) for aikit, [host.ts](../../packages/harness/src/plugin/host.ts) for plugin setup.

A Promise callback that must call back into Effect captures the enclosing context with `Effect.runPromiseWith(yield* Effect.context<never>())`, as [stdio.ts](../../packages/harness/src/mcp/stdio.ts) and [agent.ts](../../packages/codework/src/acp/agent.ts) do. The callback keeps the caller's services and tracing. Never start a fresh runtime inside a service.

The harness's [host.ts](../../packages/harness/src/host.ts) builds Node's `FileSystem`, `Path` and `Crypto` once at module level. They are for files the harness owns on the host. Anything inside a sandbox goes through the sandbox's own IO, never these.

## Diagnostics and Imports

The Effect language service runs in `harness`, `codework` and `plugin` with strict severities (see each `tsconfig.json`). Node built-in imports, global `Date`, `fetch`, timers, `console` and `Math.random`, and `JSON.parse` where a Schema fits are all errors. Use Effect's platform services, `Clock` and `Schema` instead. Tests are the host boundary, so the harness and plugin `tsconfig.json` turn those rules off under `test/`.

A rule is turned off only with a reason:

```ts
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
```

For a single line, put `// @effect-diagnostics-next-line <rule>:off` under a comment saying why. `oxlint-disable effecttsgo/...` directives take the same `-- reason` suffix.

Effect modules are named imports from the `effect` root (`import { Effect, Layer } from "effect"`), plus subpaths for areas outside it, such as `effect/rpc`, `effect/http`, `effect/sql`, `effect/cli` and `effect/process`. Our own modules are namespace imports with the `.ts` extension.
