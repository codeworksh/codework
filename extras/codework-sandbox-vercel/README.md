# @acme/codework-sandbox-vercel

An example third-party **sandbox driver**. It runs a session's filesystem and shell in a Vercel Sandbox microVM, under the driver name `codework.test.vercel`. Read it to see how a driver package is built on the public SDK and how an embedder loads it; the `@acme` scope stands in for your own.

## How It Works

Sandbox drivers are not `plugins` entries, and no settings file selects them. The embedder hands them to the harness in code, through `Harness.layer({ sandboxes })`. The `codework` CLI passes its own built-in drivers that way ([`cli/harness.ts`](../../packages/codework/src/cli/harness.ts)), so this example is not loaded by the CLI.

- **Public SDK only.** It imports `SandboxDriver`, `SandboxIO`, `SandboxFileSystem`, `SandboxShell` and `SandboxProvider` from `@codeworksh/plugin/sandbox`, and `@vercel/sandbox` for the provider.
- **One module, one driver.** The default export is `SandboxDriver.module({ apiVersion, name, options, make })`. The loader checks the API version, decodes `options` against the module's schema, and requires the driver `make` returns to carry the same name.
- **A remote driver.** It declares every capability (`inspect`, `reattach`, `wake`, `stop`, `destroy`, `cancels`) and maps Vercel's statuses onto the harness's `online`, `offline`, `suspending` and `faulted`.
- **A name that is not reserved.** `vercel` belongs to the built-in driver, so a third-party package must pick its own.

Module options are `token`, `teamId` and `projectId`, used only when all three are set. Create config, passed to `Sandbox.create`, takes `snapshot`, `runtime`, `envVars`, `timeout` and `execTimeout`.

## Loading It

The loader resolves an npm package name from the harness's `hostCwd`, so install the package beside your embedder. An installed copy imports `dist/`, so build it first.

```ts
import { Harness, Sandbox } from "@codeworksh/harness/effect";
import { ManagedRuntime } from "effect";

const runtime = ManagedRuntime.make(
	Harness.layer({
		// Or { package: "@acme/codework-sandbox-vercel", options: { token, teamId, projectId } }
		sandboxes: ["@acme/codework-sandbox-vercel"],
	}),
);

const sandbox = await runtime.runPromise(
	Sandbox.create({ driver: "codework.test.vercel", config: { runtime: "node24", timeout: 300_000 } }),
);
```

You can also import the module and pass a driver directly: `sandboxes: [VercelExample.make({})]`.

## Code Map

- [`src/index.ts`](./src/index.ts): options and config schemas, the filesystem and shell adapters, and the driver.
- [`codework-sandbox-vercel-smoke.mjs`](../../packages/harness/test/scripts/codework-sandbox-vercel-smoke.mjs): packs this package, installs it beside the harness and loads it the way an embedder would.
- [`sandboxes/vercel`](../../packages/harness/src/sandboxes/vercel/index.ts): the built-in Vercel driver. When a change to one should reach the other, compare them.

## Working Locally

```sh
pnpm run build      # tsc -p tsconfig.build.json, into dist/
pnpm run typecheck
pnpm run check
```

See [Sandboxes](../../docs/internals/06_sandboxes.md) for the driver contract and lifecycle.
