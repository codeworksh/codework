import "./utils/env.ts";
import type { Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { inspect } from "../src/plugin/loader.ts";
import { probe } from "../src/plugin/npm.ts";
import { type Fetchable, parse } from "../src/plugin/source.ts";
import type { LLM } from "../src/runner/llm.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { pendingCall } from "./tools.fixture.ts";

/*
 * Two plugins published the way a third party publishes them: their own repositories, their own
 * release tags, built output committed, and `@codeworksh/plugin` taken from npm rather than from
 * this workspace. Nothing here is a fixture -- the specs below are cloned from github, installed
 * by arborist into a real store, imported by the real loader, and run in a real session.
 *
 * What that buys over `plugin.external.test.ts`, which loads plugins by path:
 *
 * 1. The published SDK is the one the plugin compiled against. A plugin resolves
 *    `@codeworksh/plugin` out of its own `node_modules`, so this is the only test where the
 *    contract crossing the package boundary is the shipped one and not a workspace alias.
 * 2. Two copies of `effect` meet. The plugin's tarball brings its own; the harness has its own.
 *    Tool registration validates schemas with `Schema.isSchema`, so a plugin built against a
 *    different copy is exactly where that would break.
 * 3. A tag is a *mutable* committish. Re-pointing `v0.2.0` and re-resolving is the update path
 *    `plugin check` and `plugin update` implement, and it cannot be observed without a real remote.
 *
 * It reaches github and the npm registry, so it fails when either is unreachable. Both repositories
 * are private, so it also needs git credentials that can read them. Opt in with
 * `CODEWORK_PLUGIN_LIVE=1`, like the other live suite.
 */

const live = process.env.CODEWORK_PLUGIN_LIVE === "1" ? describe : describe.skip;

const TOOL = "github:codeworksh/codework-tool-spacex";
const PROMPT = "github:codeworksh/codework-prompt-musk";

interface Workspace {
	readonly root: string;
	readonly home: string;
	readonly cache: string;
}

const withWorkspace = async (body: (workspace: Workspace) => Promise<void>) => {
	const root = await mkdtemp(join(tmpdir(), "codework-plugin-git-"));
	const home = join(root, "home");
	try {
		await mkdir(join(root, ".codework"), { recursive: true });
		await mkdir(home, { recursive: true });
		await body({ root, home, cache: join(home, "cache") });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

/** What `codework plugin add` does: install, import, and report what the module turned out to be. */
const install = (reference: string, workspace: Workspace) =>
	Effect.runPromise(inspect(reference, { cache: workspace.cache, hostDir: workspace.root }));

const settings = (workspace: Workspace, plugins: ReadonlyArray<unknown>) =>
	writeFile(join(workspace.root, ".codework", "settings.jsonc"), JSON.stringify({ plugins }, null, "\t"));

/** One `Session.create` + one `run`, capturing what actually reached the provider. */
const exchange = (workspace: Workspace, open?: LLM.Open) => {
	const contexts: Message.Context[] = [];
	const turn = open ?? toolTurn();
	return Effect.gen(function* () {
		const session = yield* Session.create({ directory: workspace.root, hostDir: workspace.root });
		yield* session.run("hello");
		return { contexts, path: yield* session.path() } as const;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: workspace.home,
				hostCwd: workspace.root,
				database: ":memory:",
				llm: (request, signal) => {
					contexts.push(request.context);
					return turn(request, signal);
				},
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);
};

live("plugins installed from git, as a third party ships them", () => {
	it("installs both plugins from their release tags and reports what each module is", { timeout: 300_000 }, async () =>
		withWorkspace(async (workspace) => {
			const tool = await install(`${TOOL}#v0.1.0`, workspace);
			const prompt = await install(`${PROMPT}#v0.1.0`, workspace);

			// The ID comes off the imported module, never from the spec -- which is what makes
			// it worth asserting: it proves the tarball was built, installed and evaluated.
			// `name` is absent by design: only a local source reports one, because only there does
			// the loader read a manifest instead of taking what the installer resolved.
			expect(tool).toMatchObject({ id: "spacex.tool.launch", version: "0.1.0" });
			expect(prompt).toMatchObject({ id: "musk.prompt.persona", version: "0.1.0" });
		}),
	);

	it("runs a git-installed tool and prompt in a real session", { timeout: 300_000 }, async () =>
		withWorkspace(async (workspace) => {
			await install(`${TOOL}#v0.1.0`, workspace);
			await install(`${PROMPT}#v0.1.0`, workspace);
			await settings(workspace, [`${TOOL}#v0.1.0`, `${PROMPT}#v0.1.0`]);

			const { contexts } = await exchange(workspace);

			// The tool reached the provider alongside the built-in, so the plugin's schemas
			// survived the trip through a *separately installed* copy of effect.
			expect(contexts[0]?.tools?.map((entry) => entry.name)).toEqual(["bash", "spacex_launch_manifest"]);
			// A prompt plugin runs after every tool plugin, so it indexed the tool above even
			// though its settings entry is written after it.
			expect(contexts[0]?.systemPrompt).toContain("## First principles");
			expect(contexts[0]?.systemPrompt).toContain("Tools available: bash, spacex_launch_manifest.");
		}),
	);

	it("executes the tool through the session's sandbox shell", { timeout: 300_000 }, async () =>
		withWorkspace(async (workspace) => {
			await install(`${TOOL}#v0.1.0`, workspace);
			await settings(workspace, [`${TOOL}#v0.1.0`, { package: `${TOOL}#v0.1.0`, options: { limit: 2 } }]);

			const { path } = await exchange(
				workspace,
				toolTurn(pendingCall("spacex_launch_manifest", {}, "call_manifest")),
			);

			const result = JSON.parse(path[1]?.parts[0]?.data ?? "{}") as {
				status?: string;
				result?: { content?: ReadonlyArray<{ text?: string }> };
			};
			expect(result.status).toBe("completed");
			const text = result.result?.content?.[0]?.text ?? "";
			// `limit: 2` is the plugin's own options block, which only it can interpret.
			expect(text).toContain("Starship");
			expect(text).toContain("Falcon Heavy");
			expect(text).not.toContain("Falcon 9");
			// `uname -s` ran in the session's sandbox, not in this process by accident.
			expect(text).toMatch(/platform: (Darwin|Linux)/);
		}),
	);

	it(
		"files two release tags side by side and loads the one the settings entry names",
		{ timeout: 300_000 },
		async () =>
			withWorkspace(async (workspace) => {
				// Two tags are two canonical specs, so they file as two store entries rather than
				// superseding one another -- which is what lets a project pin one while another
				// project pins the other, out of one shared store.
				expect(await install(`${PROMPT}#v0.1.0`, workspace)).toMatchObject({ version: "0.1.0" });
				expect(await install(`${PROMPT}#v0.2.0`, workspace)).toMatchObject({ version: "0.2.0" });

				// Only the entry the settings file names is loaded, though both are filed.
				await settings(workspace, [`${PROMPT}#v0.2.0`]);

				const { contexts } = await exchange(workspace);
				// The 0.2.0 heading, which 0.1.0 does not render.
				expect(contexts[0]?.systemPrompt).toContain("## Engineering doctrine");
			}),
	);

	it("pins a commit: the spec is immutable, so probing it never opens a socket", { timeout: 300_000 }, async () =>
		withWorkspace(async (workspace) => {
			// Asked through npm's own git support, which is the path the install uses -- and the
			// only one that authenticates against a private remote. `git ls-remote` over https
			// cannot: it prompts for a username and fails.
			const branch = Effect.runSync(parse(`${PROMPT}#main`, workspace.root)) as Fetchable;
			const sha = await Effect.runPromise(probe(branch, workspace.cache, workspace.root));
			expect(sha).toMatch(/^[a-f0-9]{40}$/);

			const pinned = `${PROMPT}#${sha}`;
			expect(await install(pinned, workspace)).toMatchObject({ id: "musk.prompt.persona" });

			// `mutable` is false for a full SHA, and `probe` answers without a network call --
			// which is what stops `plugin check` from hitting a remote per pinned plugin.
			const target = Effect.runSync(parse(pinned, workspace.root)) as Fetchable;
			expect(target.mutable).toBe(false);
			expect(await Effect.runPromise(probe(target, workspace.cache, workspace.root))).toBeUndefined();
		}),
	);
});
