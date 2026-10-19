/*
 * @file Build the model catalog for publishing, and decide whether to publish it.
 *
 * `vp run catalog <out>` writes the catalog `aikit modelgen` builds to `<out>`, checks it, and
 * compares it with the published one. It sets `changed=true|false` in `$GITHUB_OUTPUT` (and
 * prints it); `.github/workflows/catalog.yml` uploads `<out>` only when it changed. A catalog that
 * fails a check exits 1 and is never published: a broken upstream must not empty every client's
 * catalog.
 */
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Value from "typebox/value";
import { generateModels } from "../src/cli/modelgen.ts";
import * as Model from "../src/model/model.ts";
import { catalogURL } from "../src/model/remote.ts";

/** Models a published catalog must list; their absence means a source broke, not a retirement. */
const REQUIRED: Record<string, string[]> = {
	anthropic: ["claude-opus-5-5", "claude-sonnet-5-5"],
	openai: ["gpt-6.1-sol", "gpt-6-luna"],
	"openai-codex": ["gpt-6.1-sol", "gpt-5.5"],
	openrouter: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5.5"],
};
/** The share of a provider's published models one update may drop. */
const MAX_DROP = 0.2;

const out = process.argv[2];
if (!out) throw new Error("usage: catalog <out>");
const path = await generateModels({ path: resolve(out) });
const bytes = await readFile(path);
const catalog = JSON.parse(bytes.toString("utf8")) as Model.BuiltInModels;

const problems: string[] = [];
for (const [provider, models] of Object.entries(catalog)) {
	for (const [id, model] of Object.entries(models ?? {})) {
		if (!Value.Check(Model.Info, model)) problems.push(`${provider}/${id} does not match Model.Info`);
	}
}
for (const [provider, ids] of Object.entries(REQUIRED)) {
	for (const id of ids) if (!catalog[provider]?.[id]) problems.push(`${provider}/${id} is missing`);
}

const response = await fetch(catalogURL(), { signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
	problems.push(`published catalog unreachable: ${error instanceof Error ? error.message : String(error)}`);
	return undefined;
});
let changed = true;
if (response === undefined) {
	// Reported above.
} else if (response.ok) {
	const live = Buffer.from(await response.arrayBuffer());
	changed = !live.equals(bytes);
	const published = JSON.parse(live.toString("utf8")) as Model.BuiltInModels;
	for (const [provider, models] of Object.entries(published)) {
		const before = Object.keys(models ?? {}).length;
		const after = Object.keys(catalog[provider] ?? {}).length;
		if (after < before * (1 - MAX_DROP)) problems.push(`${provider} drops from ${before} to ${after} models`);
	}
} else if (response.status !== 404) {
	// Without the published catalog there is nothing to check a drop against.
	problems.push(`published catalog responded ${response.status} ${response.statusText}`);
}

if (problems.length > 0) {
	console.error(`Refusing to publish the model catalog:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
	process.exit(1);
}
console.log(`changed=${changed}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
