# @acme/codework-prompt-life

An example third-party **prompt plugin**: it adds a `<meaning_of_life>` section to the system
prompt.

The package uses the example `@acme` namespace to demonstrate how a third-party scoped plugin is
loaded and then configured by package name.

## Using it

```jsonc
{
	"plugins": ["@acme/codework-prompt-life", { "package": "@acme/codework-prompt-life", "options": { "answer": 42 } }],
}
```

The string loads the module, the object configures it.

> **Not installable as written**, for the same reason as `@acme/codework-tool-proc`: it exports
> TypeScript, and Node will not strip types under `node_modules`. In this repository it is loaded
> by path as a dev-only example; a published plugin package ships built JavaScript.

| option   | type   | default | meaning                            |
| -------- | ------ | ------- | ---------------------------------- |
| `answer` | number | `42`    | the number the short version gives |

## Worth noting

- **It writes a section, not the prompt.** `Section.define("meaning_of_life")` names its block, and
  the harness renders it as `<meaning_of_life>` after the built-in sections. Order between plugins
  no longer decides where it lands.
