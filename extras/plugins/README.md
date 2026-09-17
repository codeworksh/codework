# Single-file example plugins

Two plugins that are not packages: one file each, loaded by path. This is the shortest way to
write a project-local plugin — no build, no publish, no version.

| file             | kind   | contributes                                                                |
| ---------------- | ------ | -------------------------------------------------------------------------- |
| `local.ts`       | tool   | `project_fact`, which answers from conventions recorded in its own options |
| `house-style.ts` | prompt | a `## House style` section listing rules from its own options              |

Both are inert without configuration: with no `options`, they register nothing rather than
adding an empty tool or an empty prompt section.

## Using them

```jsonc
// <project>/codework.json — `./` anchors to the directory of the file that declares it
{
	"plugins": [
		"./plugins/local.ts",
		{ "package": "./plugins/local.ts", "options": { "facts": { "deploy": "vercel", "tests": "vp test" } } },
		"./plugins/house-style.ts",
		{ "package": "./plugins/house-style.ts", "options": { "rules": ["No `any` in TypeScript."] } },
	],
}
```

Two entries per plugin: the module, then its configuration. A configuration entry names the
module by the same path (`package`) or the plugin by its ID (`plugin`, here `local.tool.facts`
and `local.prompt.house-style`); it never loads anything, so if the path is wrong the entry is
ignored rather than failing the boot.

A relative path resolves against the file that declared it, in both spellings, so the same entry
in `~/.codework/settings.json` names `~/.codework/plugins/local.ts`. Absolute paths, `file:` URLs
and `~/…` are taken as written.

## One thing settings cannot do

These land after the built-ins, and a prompt plugin only sees what registered before it. So
`project_fact` reaches the model with its own description but is missing from the system prompt's
tool list, and `house-style.ts` appends to the prompt `codework.prompt.default` already rendered
(which is what you want). A settings file names modules and configures plugins; it cannot
reorder the built-in selection. An embedder that needs the tool listed owns the whole order
through `Harness.layer({ plugins })`.
