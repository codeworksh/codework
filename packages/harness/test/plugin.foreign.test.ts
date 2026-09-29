import "./utils/env.ts";
import type { Message } from "@codeworksh/aikit";
import { Effect, Schema } from "effect";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * Why an installed plugin has to share the harness's Effect instance.
 *
 * A plugin installed from npm or git gets its own `node_modules`, so its `effect` is a separate
 * module instance even at the same version. This file is the evidence for what that costs, and
 * therefore for the deduplication `util/module.ts` performs at resolution.
 *
 * Registration survives the crossing: a foreign generator runs, a foreign `setup` signature is
 * called, an options block arrives, and a service tag resolves -- Effect's `Context` is keyed by
 * the tag's string id (`Context.ts`, `mapUnsafe.get(key.key)`) rather than by object identity.
 * The tool reaches the provider intact. Nothing after that works: the turn dies committing the
 * assistant part with `SchemaError: Expected JSON value at ["data"]["part"]`, and a schema
 * carrying a check rejects every value.
 *
 * Two corrections are worth recording, because both were believed here before and both were wrong.
 *
 * 1. This file used to claim instances of one version "interoperate completely -- services,
 *    schemas and all". They do not. The fixture took its second instance by re-importing `effect`
 *    under a query string, and `effect`'s entry re-exports from submodules whose specifiers carry
 *    no query -- so they resolved to the modules already loaded and `foreign.Schema === Schema`.
 *    There was no second instance and the test proved nothing. The fixture now tags the whole
 *    subgraph, which is what a separate install actually produces.
 * 2. The commit failure was attributed to effect@4.0.0-beta.107, i.e. to a version difference. It
 *    reproduces at the pinned version with only the instance separated, so the variable was never
 *    the version -- a different version simply implies a different directory, hence a separate
 *    instance. The pin is still worth keeping and the second test still guards it, but for
 *    ordinary compatibility reasons rather than as the thing that makes plugins safe.
 */
/** Only the three dependency groups matter here; everything else in a manifest is noise. */
const Group = Schema.optional(Schema.Record(Schema.String, Schema.String));
const Manifest = Schema.Struct({ dependencies: Group, devDependencies: Group, peerDependencies: Group });
type Manifest = typeof Manifest.Type;

const foreign = fileURLToPath(new URL("./plugins/host/acme-foreign-effect.ts", import.meta.url));

describe("plugins built against another Effect instance", () => {
	it("registers across instances and then cannot finish the turn, which is what dedupe prevents", () =>
		withSettings(async ({ root }) => {
			const contexts: Message.Context[] = [];
			const { path } = await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.run("hello");
					return { path: yield* session.path() } as const;
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: root,
							database: ":memory:",
							llm: (request, signal) => {
								contexts.push(request.context);
								return toolTurn(pendingCall("foreign_echo", { value: "ok" }, "call_foreign"))(request, signal);
							},
							plugins: [foreign, { package: foreign, options: { marker: "configured" } }, defaultPromptPlugin],
						}),
					),
					Effect.scoped,
				),
			);

			// Everything up to the provider works, which is exactly why this is dangerous: a
			// foreign generator ran, an options block arrived, a service tag resolved, and the
			// built-in prompt plugin indexed the tool.
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["foreign_echo"]);

			// And then the turn cannot be committed. The plugin is not at fault and nothing it
			// could do would help -- only the host sharing its instance does, which is what the
			// loader now arranges for a plugin that imports `effect` by name.
			const assistant = path.at(-1);
			expect(assistant?.entry.type).toBe("assistant");
			expect(assistant?.entry.state).toBe("aborted");
			expect(assistant?.parts).toEqual([]);
		}));

	it("pins one Effect version, declared and resolved alike, across the workspace", async () => {
		// One version across the workspace, so the dedupe above has a single copy to point every
		// plugin at. A second version reaching the tree — a package upgraded on its own, or a
		// transitive dependency — gives it two candidates and puts some plugin on the wrong one,
		// with the failure above as the result. The expected version is read from this package
		// rather than written here, so an upgrade is a one-line change and a partial one fails.
		const root = new URL("../../../", import.meta.url);
		const manifest = async (path: string): Promise<Manifest> =>
			Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await readFile(new URL(path, root), "utf8"));
		const pinned = (await manifest("packages/harness/package.json")).peerDependencies?.effect;
		expect(pinned).toBeDefined();

		// Every workspace package that names `effect` names the same version.
		const manifests: string[] = [];
		for await (const path of glob("{packages,extras}/*/package.json", { cwd: fileURLToPath(root) })) {
			manifests.push(path);
		}
		const declared = new Map<string, string>();
		for (const path of manifests.sort()) {
			const parsed = await manifest(path);
			for (const group of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies]) {
				const version = group?.["effect"];
				if (version !== undefined) declared.set(path, version);
			}
		}
		expect([...new Set(declared.values())]).toEqual([pinned]);

		// And the lockfile resolves that one version, so nothing arrived through a dependency.
		const lockfile = await readFile(new URL("pnpm-lock.yaml", root), "utf8");
		const resolved = new Set([...lockfile.matchAll(/^ {2}effect@(\S+):$/gm)].map((match) => match[1]));
		expect([...resolved]).toEqual([pinned]);
	});
});
