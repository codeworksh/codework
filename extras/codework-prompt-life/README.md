# codework-prompt-life

An example third-party **prompt plugin**: it appends a short section on the meaning of life to
the system prompt.

The package name is deliberately unscoped, so it shows the other spelling a settings entry can
take — `codework-prompt-life` alongside `@acme/codework-tool-proc`.

## Using it

```jsonc
{
	"plugins": ["codework-prompt-life", { "package": "codework-prompt-life", "options": { "answer": 42 } }],
}
```

The string loads the module, the object configures it. Settings entries append after the
built-ins, so this lands after `codework.prompt.default` and composes on the prompt it rendered —
which is where a prompt plugin wants to be.

> **Not installable as written**, for the same reason as `@acme/codework-tool-proc`: it exports
> TypeScript, and Node will not strip types under `node_modules`. In this repository it is loaded
> by path as a dev-only example; a published plugin package ships built JavaScript.

| option   | type   | default | meaning                            |
| -------- | ------ | ------- | ---------------------------------- |
| `answer` | number | `42`    | the number the short version gives |

## Worth noting

- **A prompt plugin replaces the whole prompt.** `ctx.plugin.prompt.set` takes the complete
  string, so this plugin reads `get()` first and composes on it instead of discarding whatever
  `codework.prompt.default` rendered.
- **It only sees earlier contributions.** Place it after the prompt plugins and tool plugins it
  builds on; a plugin that runs before them sees nothing they registered.
