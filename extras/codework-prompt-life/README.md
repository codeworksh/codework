# @acme/codework-prompt-life

An example third-party **prompt plugin**. It adds a `<meaning_of_life>` section to the system prompt, with an answer you can configure. Read it to see the smallest complete prompt plugin; the `@acme` scope stands in for your own.

## How It Works

The package default-exports one `Plugin.define({ id: "acme.prompt.life", kind: "prompt", setup })` object from [`@codeworksh/plugin`](../../packages/plugin/src/index.ts), which is all the loader reads.

- **It opens its own section.** `Section.define("meaning_of_life")` names the block, and `setup` appends to it. The harness renders custom sections after the built-in ones, so where it lands does not depend on which plugin ran first.
- **It checks its own options.** The harness hands the `options` block over untouched. A missing or non-numeric `answer` falls back to `42` instead of failing the boot.

| Option   | Default | Meaning                            |
| -------- | ------- | ---------------------------------- |
| `answer` | `42`    | The number the short version gives |

## Loading It

A string entry loads the module, and an object entry configures a module already loaded. In this repository, add it from the repo root:

```sh
codework plugin add ./extras/codework-prompt-life
```

That writes the path into `.codework/settings.jsonc`, anchored to the settings file. Then configure it:

```jsonc
// .codework/settings.jsonc
{
	"plugins": [
		"../extras/codework-prompt-life",
		{ "package": "@acme/codework-prompt-life", "options": { "answer": 42 } },
	],
}
```

The `package` entry can use the npm name because a local package is also known by the name its `package.json` declares. `codework plugin list` shows what each entry resolved to.

> [!NOTE]
> This example is not installable from a registry as written. It exports TypeScript from `src/`, and Node will not strip types under `node_modules`. A published plugin ships built JavaScript.

## Code Map

- [`src/index.ts`](./src/index.ts): the whole plugin.

See [Plugins](../../docs/internals/08_plugins.md) for kinds, entries and the store.
