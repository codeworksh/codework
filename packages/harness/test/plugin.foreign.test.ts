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
 * A plugin installed from npm gets its own `node_modules`, so its `effect` is a different module
 * instance than the harness's. The whole plugin model rests on that working: a plugin's `setup`
 * is a generator from its copy, and it resolves harness services through tags built by ours.
 * Effect's `Context` is keyed by the tag's string id (`Context.ts`, `mapUnsafe.get(key.key)`)
 * rather than by object identity, which is what makes it work. This is the guard on that: a
 * change there breaks every installed plugin at once, and nothing else in the suite would notice.
 *
 * Instances of the *same version* interoperate completely — services, schemas and all. Two
 * different *versions* do not: the same fixture against effect@4.0.0-beta.107 registers its tool
 * and reaches the provider, then dies committing the result with `SchemaError: Expected JSON
 * value at ["data"]["part"]`. One pinned Effect version is therefore the thing that makes
 * installed plugins safe, which the second test here guards.
 */
/** Only the three dependency groups matter here; everything else in a manifest is noise. */
const Group = Schema.optional(Schema.Record(Schema.String, Schema.String));
const Manifest = Schema.Struct({ dependencies: Group, devDependencies: Group, peerDependencies: Group });
type Manifest = typeof Manifest.Type;

const foreign = fileURLToPath(new URL("./plugins/host/acme-foreign-effect.ts", import.meta.url));

describe("plugins built against another Effect instance", () => {
	it("resolves harness services and runs its tool", () =>
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
							cwd: root,
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
			// Registered by a foreign-copy generator, and indexed by the built-in prompt plugin.
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["foreign_echo"]);
			// `shell:` proves `yield* SandboxIO.Shell` resolved across the copies; `configured`
			// proves the options block reached the second argument of a foreign `setup`.
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({ status: "completed" });
			expect(settled.result.content[0].text).toBe("shell:configured:ok");
		}));

	it("pins one Effect version, declared and resolved alike, across the workspace", async () => {
		// The interop above holds between instances of one version, not across versions. A second
		// version reaching the tree — a package upgraded on its own, or a transitive dependency —
		// puts a plugin and the harness on incompatible schemas, so the pin is the guarantee and
		// this is its guard. The expected version is read from this package rather than written
		// here, so an upgrade is a one-line change and a partial one fails instead.
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
