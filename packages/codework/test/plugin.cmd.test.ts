/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, Session } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { NAME, npmrc, withRegistry } from "../../harness/test/fixtures/registry.ts";

// The runtime half of an E2E boots the harness in-process, which reads the workspace catalog.
process.env.CODEWORK_MODELS_FILE ??= fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const plugin = (name: string) => fileURLToPath(new URL(`../../../extras/${name}`, import.meta.url));

/** One temp project with its own home, so nothing here reads or writes the developer's settings. */
const withProject = async (body: (project: { root: string; home: string; run: Run }) => void | Promise<void>) => {
	const root = mkdtempSync(join(tmpdir(), "codework-plugin-"));
	const home = join(root, "home");
	// A project is a directory holding `.codework/`. Most of these tests are about editing a
	// project that already exists, so the marker is created here; the two that are about
	// *finding* a project make their own.
	mkdirSync(join(root, ".codework"), { recursive: true });
	const run: Run = (...args) =>
		spawnSync(process.execPath, ["--conditions=development", cli, ...args, "--home", home], {
			encoding: "utf8",
			cwd: root,
			timeout: 60_000,
		});
	try {
		await body({ root, home, run });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};
type Run = (...args: ReadonlyArray<string>) => SpawnSyncReturns<string>;

const runAsyncResult = (cwd: string, ...args: ReadonlyArray<string>) =>
	new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>(
		(resolve, reject) => {
			const child = spawn(process.execPath, ["--conditions=development", cli, ...args], { cwd });
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => (stdout += chunk));
			child.stderr.on("data", (chunk: string) => (stderr += chunk));
			child.on("error", reject);
			child.on("close", (status) => resolve({ status, stdout, stderr }));
		},
	);

const runAsync = (cwd: string, ...args: ReadonlyArray<string>) =>
	runAsyncResult(cwd, ...args).then(({ status }) => status);

/** A fixed generation number, so a published fixture is byte-identical between runs. */
const GENERATION = 1789564800000;

/** The one project settings file: `<root>/.codework/settings.jsonc`. */
const settings = (root: string) => join(root, ".codework", "settings.jsonc");

/** An `.npmrc` whose registry refuses every connection, so an install anchored to it fails now. */
const DEAD_NPMRC = "registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nfetch-retries=0\n";

/**
 * A published prompt plugin that leaves a marker, so the runtime proves which artifact it loaded:
 * `served` names the registry the bytes came from, and an options `marker` replaces it.
 */
const ownerPlugin = (served: string) =>
	[
		"export default {",
		"  id: 'fixture.prompt.owner',",
		"  kind: 'prompt',",
		"  setup: (ctx, options) =>",
		`    ctx.plugin.prompt.set(\`\${ctx.plugin.prompt.get() ?? ''}[owner:\${options.marker ?? '${served}'}]\`),`,
		"};",
		"",
	].join("\n");

const LOCAL_PLUGIN = [
	"export default {",
	"  id: 'fixture.prompt.local',",
	"  kind: 'prompt',",
	"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}[local]`),",
	"};",
	"",
].join("\n");

/**
 * Exchanges in one real runtime process, resolve-only, against what the CLI filed -- one per host
 * directory, in order, each keeping its own session. The markers each system prompt ends with are
 * the plugins that exchange actually ran.
 *
 * The app runs from its home (`hostCwd`), nowhere near a project: settings reach a session only
 * through the `hostDir` it is linked to. Its sandbox working directory is left to the session.
 */
const exchanges = async (
	home: string,
	hostDirs: ReadonlyArray<string>,
	app: { readonly hostCwd?: string; readonly userConfigDir?: string } = {},
) => {
	const prompts: string[] = [];
	const open = immediateOpen();
	await Effect.runPromise(
		Effect.gen(function* () {
			const sessions = new Map<string, Effect.Success<ReturnType<typeof Session.create>>>();
			for (const hostDir of hostDirs) {
				const session = sessions.get(hostDir) ?? (yield* Session.create({ hostDir }));
				sessions.set(hostDir, session);
				yield* session.prompt({ text: "go", delivery: "followUp" });
				yield* session.resume();
				yield* session.wait();
			}
		}).pipe(
			Effect.provide(
				Harness.layer({
					home,
					hostCwd: app.hostCwd ?? home,
					...(app.userConfigDir === undefined ? {} : { userConfigDir: app.userConfigDir }),
					database: ":memory:",
					llm: (request, signal) => {
						prompts.push(request.context.systemPrompt ?? "");
						return open(request, signal);
					},
				}),
			),
			Effect.scoped,
			Effect.timeout("20 seconds"),
			Effect.orDie,
		),
	);
	expect(prompts).toHaveLength(hostDirs.length);
	return prompts.map((prompt) => prompt.match(/\[(?:owner:[^\]]*|git:[^\]]*|layer:[^\]]*|local)\]/g) ?? []);
};

/**
 * The run as a reviewable file: temp paths and the fixture's port are replaced, and column padding
 * (sized to those machine-specific paths) is collapsed, so the same behaviour writes the same bytes
 * on any machine and a change in it shows up as a diff.
 */
const artifact = (root: string, registries: ReadonlyArray<string>, record: Record<string, unknown>) =>
	registries
		.reduce(
			(text, url, index) => text.replaceAll(url, `<registry-${index + 1}>/`),
			`${JSON.stringify(record, null, "\t")}\n`.replaceAll(realpathSync(root), "<root>").replaceAll(root, "<root>"),
		)
		.replaceAll(/ {2,}/g, "  ");

describe("codework plugin add/remove", () => {
	it("adds a plugin to the project file, keeping its comments and formatting", () =>
		withProject(({ root, run }) => {
			// A settings file is written by hand; an edit from the CLI must leave it recognisable.
			writeFileSync(
				settings(root),
				["{", "\t// The model this project works against.", '\t"model": { "thinkingLevel": "low" },', "}", ""].join(
					"\n",
				),
			);
			chmodSync(settings(root), 0o640);
			const added = run("plugin", "add", plugin("codework-tool-proc"));
			expect(added.status).toBe(0);
			// The reported ID comes from importing the module, not from the spec the user typed.
			expect(added.stdout).toContain("Added acme.tool.proc");

			const file = readFileSync(settings(root), "utf8");
			expect(file).toContain("// The model this project works against.");
			expect(file).toContain('"thinkingLevel": "low"');
			expect(file).toContain(plugin("codework-tool-proc"));
			expect(statSync(settings(root)).mode & 0o777).toBe(0o640);

			// Adding it twice says so instead of writing a duplicate entry.
			const again = run("plugin", "add", plugin("codework-tool-proc"));
			expect(again.status).toBe(0);
			expect(again.stdout).toContain("already configured");
			expect(readFileSync(settings(root), "utf8")).toBe(file);
		}));

	it("serializes concurrent additions so neither successful edit is lost", () =>
		withProject(async ({ root, home }) => {
			for (const name of ["a", "b"]) {
				writeFileSync(
					join(root, `${name}.mjs`),
					`export default { id: "acme.tool.${name}", kind: "tool", setup() {} };\n`,
				);
			}
			writeFileSync(settings(root), JSON.stringify({ plugins: [] }));

			const statuses = await Promise.all(
				["a", "b"].map((name) => runAsync(root, "plugin", "add", `./${name}.mjs`, "--home", home)),
			);

			expect(statuses).toEqual([0, 0]);
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins.sort()).toEqual(["../a.mjs", "../b.mjs"]);
		}));

	it("removes the module entry and the configuration written against it", () =>
		withProject(({ root, run }) => {
			const target = plugin("codework-tool-proc");
			writeFileSync(
				settings(root),
				JSON.stringify({
					plugins: ["./plugins/keep.ts", target, { plugin: "acme.tool.proc", options: { limit: 5 } }],
				}),
			);
			const removed = run("plugin", "remove", target);
			expect(removed.status).toBe(0);
			expect(removed.stdout).toContain("Removed 2 entries");
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual(["./plugins/keep.ts"]);

			// Removing what is not there is not a failure, and changes nothing.
			const twice = run("plugin", "remove", target);
			expect(twice.status).toBe(0);
			expect(twice.stdout).toContain("is not configured");
		}));

	it("does not create a project when removing from an unconfigured directory", () => {
		const root = mkdtempSync(join(tmpdir(), "codework-plugin-remove-"));
		const home = join(root, "home");
		try {
			const removed = spawnSync(
				process.execPath,
				["--conditions=development", cli, "plugin", "remove", "@acme/missing", "--home", home],
				{ encoding: "utf8", cwd: root, timeout: 60_000 },
			);
			expect(removed.status).toBe(0);
			expect(removed.stdout).toContain("is not configured");
			expect(existsSync(join(root, ".codework"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("adds a loader before configuration that already names the plugin", () =>
		withProject(({ root, run }) => {
			const target = plugin("codework-tool-proc");
			const configured = [
				{ package: target, options: { limit: 5 } },
				{ plugin: "acme.tool.proc", options: { limit: 3 } },
			];
			writeFileSync(settings(root), JSON.stringify({ plugins: configured }));

			const added = run("plugin", "add", target);
			expect(added.status).toBe(0);
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual([target, ...configured]);
		}));

	it("removes by the ID the module declares, whichever spelling the entry used", () =>
		withProject(({ root, run }) => {
			// Nobody reads the ID off the package they installed; they read it from the
			// configuration block they wrote. Removing by it has to take the module entry too,
			// or the plugin keeps loading with its configuration gone.
			const target = plugin("codework-tool-proc");
			writeFileSync(
				settings(root),
				JSON.stringify({ plugins: [target, { plugin: "acme.tool.proc", options: { limit: 5 } }, "./keep.ts"] }),
			);
			const removed = run("plugin", "remove", "acme.tool.proc");
			expect(removed.status).toBe(0);
			expect(removed.stdout).toContain("Removed 2 entries");
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual(["./keep.ts"]);
		}));

	it("removes a cached registry package by its declared ID without fetching", () =>
		withProject(({ root, home, run }) => {
			const spec = "fixture-codework-plugin@1.2.0";
			// A published store entry, laid out the way the store lays one out: slug, full
			// digest, then a generation whose marker is what makes it exist.
			const directory = join(
				home,
				"cache",
				"plugins",
				"v2",
				"fixture-codework-plugin",
				createHash("sha256").update(`https://registry.npmjs.org/\0${spec}`).digest("hex"),
				String(GENERATION),
			);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "index.mjs"),
				"export default { id: 'acme.tool.cached', kind: 'tool', setup() {} }",
			);
			writeFileSync(
				join(directory, ".complete.json"),
				JSON.stringify({
					spec,
					name: "fixture-codework-plugin",
					version: "1.2.0",
					entrypoint: "index.mjs",
					createdAt: GENERATION,
				}),
			);
			writeFileSync(
				settings(root),
				JSON.stringify({ plugins: [spec, { plugin: "acme.tool.cached", options: { limit: 5 } }, "./keep.ts"] }),
			);

			const removed = run("plugin", "remove", "acme.tool.cached");
			expect(removed.status).toBe(0);
			expect(removed.stdout).toContain("Removed 2 entries");
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual(["./keep.ts"]);
		}));

	it("rewrites the entry in place when the same plugin is added under a new version", () =>
		withProject(({ root, home, run }) => {
			// npm rewrites the recorded spec rather than installing a version the manifest does not
			// name. Two loaders for one plugin would be worse than either: the harness keeps the
			// last and discards the first, so the file would say one thing and the run do another.
			const publish = (version: string, id: string) => {
				const spec = `fixture-codework-plugin@${version}`;
				const directory = join(
					home,
					"cache",
					"plugins",
					"v2",
					"fixture-codework-plugin",
					createHash("sha256").update(`https://registry.npmjs.org/\0${spec}`).digest("hex"),
					String(GENERATION),
				);
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "index.mjs"), `export default { id: '${id}', kind: 'tool', setup() {} }`);
				writeFileSync(
					join(directory, ".complete.json"),
					JSON.stringify({
						spec,
						name: "fixture-codework-plugin",
						version,
						entrypoint: "index.mjs",
						createdAt: GENERATION,
					}),
				);
				return spec;
			};
			const before = publish("1.2.0", "acme.tool.pinned");
			const after = publish("2.0.0", "acme.tool.pinned");
			writeFileSync(
				settings(root),
				JSON.stringify({ plugins: [before, { plugin: "acme.tool.pinned", options: { limit: 5 } }] }),
			);

			const updated = run("plugin", "add", after);
			expect(updated.status).toBe(0);
			expect(updated.stdout).toContain("Updated acme.tool.pinned");
			// The configuration written against it is left exactly where it was.
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual([
				after,
				{ plugin: "acme.tool.pinned", options: { limit: 5 } },
			]);

			// The same spelling twice is still a no-op, and still says so.
			const again = run("plugin", "add", after);
			expect(again.status).toBe(0);
			expect(again.stdout).toContain("already configured");
		}));

	it("edits the settings file an ancestor declares rather than starting a second one", () =>
		withProject(({ root }) => {
			// Discovery walks up, so the file that is read from `packages/app` is the repository's.
			// Writing a new one next to the command would leave an edit the harness never reads.
			writeFileSync(settings(root), JSON.stringify({ plugins: [] }));
			const nested = join(root, "packages", "app");
			mkdirSync(nested, { recursive: true });
			const added = spawnSync(
				process.execPath,
				[
					"--conditions=development",
					cli,
					"plugin",
					"add",
					plugin("codework-tool-proc"),
					"--home",
					join(root, "home"),
				],
				{ encoding: "utf8", cwd: nested, timeout: 60_000 },
			);
			expect(added.status).toBe(0);
			expect(added.stdout).toContain(settings(root));
			expect(existsSync(settings(nested))).toBe(false);
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual([plugin("codework-tool-proc")]);
		}));

	it("starts a project where the command ran when no ancestor is one, and says so", () =>
		withProject(({ root, home }) => {
			// No marker anywhere above this directory, so `add` decides a project begins here.
			// That decision shadows any outer project from now on and sends every future entry
			// to this file, which is why it is printed rather than done quietly.
			// macOS spells the temporary directory through `/var` while `cwd` resolves through
			// `/private/var`; the command reports the path it resolved, so compare against that.
			const loose = join(realpathSync(root), "loose");
			mkdirSync(loose, { recursive: true });
			rmSync(join(root, ".codework"), { recursive: true, force: true });
			const added = spawnSync(
				process.execPath,
				["--conditions=development", cli, "plugin", "add", plugin("codework-tool-proc"), "--home", home],
				{ encoding: "utf8", cwd: loose, timeout: 60_000 },
			);
			expect(added.status).toBe(0);
			expect(added.stdout).toContain(`Created ${join(loose, ".codework")}/`);
			expect(JSON.parse(readFileSync(settings(loose), "utf8")).plugins).toEqual([plugin("codework-tool-proc")]);
			// And nothing was written above it.
			expect(existsSync(settings(root))).toBe(false);
		}));

	it("refuses a session it cannot resolve, rather than falling back to the shell's directory", () =>
		withProject(({ root, home }) => {
			// A session's host directory is the only other honest answer to "which project": a
			// `Project` is env-independent by design and has no host path to offer, and a space's
			// location means something inside an env that may not be this machine.
			const elsewhere = join(realpathSync(root), "elsewhere");
			mkdirSync(elsewhere, { recursive: true });

			const added = spawnSync(
				process.execPath,
				[
					"--conditions=development",
					cli,
					"plugin",
					"add",
					plugin("codework-tool-proc"),
					"--session",
					"ses_00000000-0000-7000-8000-000000000000",
					"--home",
					home,
				],
				{ encoding: "utf8", cwd: elsewhere, timeout: 60_000 },
			);

			// Falling back to the directory the command ran in would write a project nobody asked
			// for, which is the failure mode naming a session is meant to avoid.
			expect(added.status).toBe(1);
			expect(added.stderr).toContain("SessionNotFound");
			expect(existsSync(settings(elsewhere))).toBe(false);
		}));

	it("does not treat the global settings file as a project file", () =>
		withProject(({ root }) => {
			// macOS spells the temporary directory through `/var` while `cwd` resolves through
			// `/private/var`; use one physical spelling for the collision this test is about.
			const physical = realpathSync(root);
			const home = join(physical, ".codework");
			const project = join(physical, "project");
			mkdirSync(home, { recursive: true });
			mkdirSync(project, { recursive: true });
			writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ plugins: [] }));

			const added = spawnSync(
				process.execPath,
				["--conditions=development", cli, "plugin", "add", plugin("codework-tool-proc"), "--home", home],
				{ encoding: "utf8", cwd: project, timeout: 60_000 },
			);
			expect(added.status).toBe(0);
			expect(added.stdout).toContain(settings(project));
			expect(JSON.parse(readFileSync(join(home, "settings.jsonc"), "utf8")).plugins).toEqual([]);
			expect(JSON.parse(readFileSync(settings(project), "utf8")).plugins).toEqual([plugin("codework-tool-proc")]);
		}));

	it("refuses a module that is not a plugin, before touching the file", () =>
		withProject(({ root, run }) => {
			writeFileSync(settings(root), JSON.stringify({ plugins: [] }));
			const notAPlugin = fileURLToPath(new URL("../../../vite.config.ts", import.meta.url));
			const failed = run("plugin", "add", notAPlugin);
			expect(failed.status).toBe(1);
			expect(failed.stderr).toContain("error[plugin-invalid-definition]");
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual([]);
		}));

	it("adds a user-wide plugin with -g, alongside what the project declares", () =>
		withProject(({ root, home, run }) => {
			writeFileSync(settings(root), JSON.stringify({ plugins: ["./plugins/project.ts"] }));
			const added = run("plugin", "add", plugin("codework-prompt-life"), "-g");
			expect(added.status).toBe(0);
			expect(added.stdout).toContain(join(home, "settings.jsonc"));
			// Entries accumulate across layers, so the project keeps its own list untouched and
			// both apply; nothing here needs to warn about one hiding the other.
			expect(JSON.parse(readFileSync(join(home, "settings.jsonc"), "utf8")).plugins).toEqual([
				plugin("codework-prompt-life"),
			]);
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual(["./plugins/project.ts"]);
		}));

	it("lets --user-config-dir outrank both the project and --global targets", () =>
		withProject(({ root, home, run }) => {
			writeFileSync(settings(root), JSON.stringify({ plugins: ["./project.ts"] }));
			mkdirSync(home, { recursive: true });
			writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ plugins: ["./global.ts"] }));

			const added = run("plugin", "add", plugin("codework-tool-proc"), "-g", "--user-config-dir", "override");
			expect(added.status).toBe(0);
			const override = join(root, "override", "settings.jsonc");
			expect(JSON.parse(readFileSync(override, "utf8")).plugins).toEqual([plugin("codework-tool-proc")]);
			expect(JSON.parse(readFileSync(settings(root), "utf8")).plugins).toEqual(["./project.ts"]);
			expect(JSON.parse(readFileSync(join(home, "settings.jsonc"), "utf8")).plugins).toEqual(["./global.ts"]);

			const removed = run("plugin", "remove", plugin("codework-tool-proc"), "-g", "--user-config-dir", "override");
			expect(removed.status).toBe(0);
			expect(JSON.parse(readFileSync(override, "utf8")).plugins).toEqual([]);
		}));
});

describe("codework plugin install/list/check", () => {
	it("re-anchors a local path to the settings file it is written into", () =>
		withProject(({ root, home }) => {
			// The defect this fixes is silent: a relative path on the command line means one file,
			// and the same string in a settings file means another the moment the command was not
			// run from the directory holding that file.
			const physical = realpathSync(root);
			const nested = join(physical, "packages", "app");
			mkdirSync(join(nested, "plugins"), { recursive: true });
			const target = join(nested, "plugins", "house.mjs");
			writeFileSync(target, "export default { id: 'acme.tool.house', kind: 'tool', setup() {} }");

			// Typed relative to where the command runs, which is not where the file lives.
			const typed = "./plugins/house.mjs";
			const added = spawnSync(
				process.execPath,
				["--conditions=development", cli, "plugin", "add", typed, "--home", home],
				{ encoding: "utf8", cwd: nested, timeout: 60_000 },
			);
			expect(added.status).toBe(0);

			// Both ends are inside one project, so the entry is written relative to the settings
			// file -- portable to any checkout of the repository, which is what makes it worth
			// committing.
			const written: string = JSON.parse(readFileSync(settings(physical), "utf8")).plugins[0];
			expect(written.startsWith("./") || written.startsWith("../")).toBe(true);
			// Written verbatim, this would have named `<root>/.codework/plugins/house.mjs`.
			expect(written).not.toBe(typed);
			expect(realpathSync(resolve(join(physical, ".codework"), written))).toBe(realpathSync(target));
		}));

	it("writes an absolute path when the target sits outside the project", () =>
		withProject(({ root, home, run }) => {
			const outside = join(realpathSync(root), "..", "elsewhere");
			// `-g` writes the user-wide file, so a relative entry would be a lie: it would be read
			// from `<home>` rather than from this project.
			const added = run("plugin", "add", plugin("codework-tool-proc"), "-g");
			expect(added.status).toBe(0);
			const written: string = JSON.parse(readFileSync(join(home, "settings.jsonc"), "utf8")).plugins[0];
			expect(isAbsolute(written)).toBe(true);
			expect(existsSync(outside)).toBe(false);
		}));

	it("lists what each entry resolved to, and the reason when it did not", () =>
		withProject(({ root, run }) => {
			writeFileSync(
				settings(root),
				JSON.stringify({ plugins: [plugin("codework-tool-proc"), "./missing.ts", "@acme/never-installed"] }),
			);
			const listed = run("plugin", "list");
			expect(listed.status).toBe(0);
			// An ID is proof the whole chain worked: it cannot be known without importing.
			expect(listed.stdout).toContain("acme.tool.proc");
			// A path with nothing at it, and a package with no store entry, are different failures.
			expect(listed.stdout).toContain("plugin-not-found");
			expect(listed.stdout).toContain("plugin-not-installed");
		}));

	it("lists the reference as written, and names the file that declared it", () =>
		withProject(({ root, run }) => {
			// Written relative, so the anchored form differs from what the person typed -- and it
			// is the typed form they will search their settings for.
			mkdirSync(join(root, ".codework", "plugins"), { recursive: true });
			writeFileSync(
				join(root, ".codework", "plugins", "house.mjs"),
				"export default { id: 'acme.tool.house', kind: 'tool', setup() {} }",
			);
			writeFileSync(settings(root), JSON.stringify({ plugins: ["./plugins/house.mjs"] }));

			const listed = run("plugin", "list", "--verbose");
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain("./plugins/house.mjs");
			expect(listed.stdout).toContain("acme.tool.house");
			// With several layers accumulating entries, "which file says this" is the question.
			expect(listed.stdout).toContain(`declared in: ${settings(realpathSync(root))}`);
		}));

	it("reports an empty configuration rather than printing nothing", () =>
		withProject(({ root, run }) => {
			writeFileSync(settings(root), JSON.stringify({ plugins: [] }));
			const listed = run("plugin", "list");
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain("No plugins are configured.");
		}));

	it("does not treat a package configuration patch as a module to install", () =>
		withProject(({ root, run }) => {
			writeFileSync(
				settings(root),
				JSON.stringify({ plugins: [{ package: "@acme/never-installed", options: { limit: 5 } }] }),
			);

			const listed = run("plugin", "list");
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain("No plugins are configured.");

			const installed = run("plugin", "install");
			expect(installed.status).toBe(0);
			expect(installed.stdout).toContain("0 installed");
		}));

	it("installs what the settings already declare, and says so when there is nothing to do", () =>
		withProject(({ root, run }) => {
			// A local entry is loaded where it lies, so `install` has nothing to fetch for it.
			writeFileSync(settings(root), JSON.stringify({ plugins: [plugin("codework-tool-proc")] }));
			const installed = run("plugin", "install");
			expect(installed.status).toBe(0);
			expect(installed.stdout).toContain("1 local");
		}));

	it(
		"installs and reports mutable plugin states through the CLI",
		() =>
			withProject(async ({ root, home }) => {
				const spec = `${NAME}@^1.0.0`;
				await withRegistry(
					join(root, "registry"),
					async (registry) => {
						await npmrc(root, registry);
						writeFileSync(settings(root), JSON.stringify({ plugins: [spec] }));

						const missing = await runAsyncResult(root, "plugin", "check", "--home", home);
						expect(missing.status).toBe(0);
						expect(missing.stdout).toContain(`${spec}  plugin-not-installed`);

						const installed = await runAsyncResult(root, "plugin", "install", "--home", home);
						expect(installed.status, installed.stderr).toBe(0);
						expect(installed.stdout).toContain(`Installed ${spec} (fixture.tool.cli)`);
						expect(installed.stdout).toContain("1 installed");

						const present = await runAsyncResult(root, "plugin", "install", "--home", home);
						expect(present.status).toBe(0);
						expect(present.stdout).toContain("0 installed, 1 already present");
					},
					{ pluginId: "fixture.tool.cli" },
				);

				// Persist the result a successful remote check would have written. `check` must render
				// that cross-process cache without opening the now-closed fixture registry.
				const indexPath = join(home, "cache", "plugins", "v2", "index.json");
				const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
					entries: Record<string, Record<string, unknown>>;
				};
				const record = Object.values(index.entries)[0];
				expect(record).toBeDefined();
				Object.assign(record ?? {}, { checkedAt: statSync(indexPath).mtimeMs, outdated: true, available: "1.1.0" });
				writeFileSync(indexPath, JSON.stringify(index));

				const checked = await runAsyncResult(root, "plugin", "check", "--home", home);
				expect(checked.status, JSON.stringify(checked)).toBe(0);
				expect(checked.stdout).toContain(`${spec}  1.0.0 -> 1.1.0`);
				expect(checked.stdout).toContain("1 update available");

				// `update` always refreshes the remote answer. The fixture is deliberately closed, so
				// this covers per-entry failure reporting and the command's non-zero exit contract.
				const updated = await runAsyncResult(root, "plugin", "update", "--home", home);
				expect(updated.status).toBe(1);
				expect(updated.stdout).toContain(`error[plugin-resolve-failed]`);
				expect(updated.stdout).toContain("Nothing to update.");
			}),
		120_000,
	);

	it(
		"installs one artifact per registry a spec in both layers resolves to, and each view loads its own",
		() =>
			withProject(async ({ root, home }) => {
				const spec = `${NAME}@^1.0.0`;
				await withRegistry(
					join(root, "user-registry"),
					(user) =>
						withRegistry(
							join(root, "project-registry"),
							async (project) => {
								// The same string in both layers, each beside an `.npmrc` naming a different
								// registry. Boot reads the user layer alone, so it needs the user file's
								// artifact; the project's sessions read the project file last, so they need
								// the project's. `install` has to put both on disk.
								await npmrc(home, user);
								writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ plugins: [spec] }));
								await npmrc(root, project);
								writeFileSync(settings(root), JSON.stringify({ plugins: [spec] }));

								const installed = await runAsyncResult(root, "plugin", "install", "--home", home);
								expect(installed.status, installed.stdout + installed.stderr).toBe(0);
								expect(installed.stdout).toContain("2 installed");
								const listed = await runAsyncResult(root, "plugin", "list", "--verbose", "--home", home);
								expect(listed.status).toBe(0);

								// One process, two views, alternating. Boot needed the user file's artifact and
								// found it; a session outside any project keeps running it, while the project's
								// session runs from its own view, where the project file owns the spec. Neither
								// evicts the other, however often they take turns.
								const elsewhere = mkdtempSync(join(tmpdir(), "codework-elsewhere-"));
								const markers = await exchanges(home, [root, elsewhere, root, elsewhere]).finally(() =>
									rmSync(elsewhere, { recursive: true, force: true }),
								);
								expect(markers).toEqual([
									["[owner:project]"],
									["[owner:user]"],
									["[owner:project]"],
									["[owner:user]"],
								]);

								await expect(
									artifact(root, [user.url, project.url], {
										layers: { user: [spec], project: [spec] },
										install: installed.stdout,
										list: listed.stdout,
										runtime: { order: ["project", "elsewhere", "project", "elsewhere"], markers },
									}),
								).toMatchFileSnapshot("./__artifacts__/plugin-owner.layers.json");
							},
							{ source: ownerPlugin("project") },
						),
					{ source: ownerPlugin("user") },
				);
			}),
		120_000,
	);

	it(
		"keeps a spec both layers resolve to one registry as a single artifact",
		() =>
			withProject(async ({ root, home }) => {
				const spec = `${NAME}@^1.0.0`;
				await withRegistry(
					join(root, "registry"),
					async (registry) => {
						// Two anchors, one registry: one store entry, so one line everywhere.
						await npmrc(home, registry);
						writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ plugins: [spec] }));
						await npmrc(root, registry);
						writeFileSync(settings(root), JSON.stringify({ plugins: [spec] }));

						const installed = await runAsyncResult(root, "plugin", "install", "--home", home);
						expect(installed.status, installed.stdout + installed.stderr).toBe(0);
						expect(installed.stdout).toContain("1 installed");
						const checked = await runAsyncResult(root, "plugin", "check", "--home", home);
						expect(checked.status).toBe(0);

						const [markers] = await exchanges(home, [root]);
						expect(markers).toEqual(["[owner:registry]"]);

						await expect(
							artifact(root, [registry.url], {
								layers: { user: [spec], project: [spec] },
								install: installed.stdout,
								check: checked.stdout,
								runtime: markers,
							}),
						).toMatchFileSnapshot("./__artifacts__/plugin-owner.shared.json");
					},
					{ source: ownerPlugin("registry") },
				);
			}),
		120_000,
	);

	it(
		"never lets a package configuration patch move the registry a module loads from",
		() =>
			withProject(async ({ root, home }) => {
				const spec = `${NAME}@^1.0.0`;
				await withRegistry(
					join(root, "registry"),
					async (registry) => {
						// The module is declared only by the user file, against a live registry. The
						// project configures it from its own file, beside a dead `.npmrc` -- and adds a
						// local plugin, which makes the exchange rebuild the pool and re-resolve every
						// module under its owner's anchor.
						mkdirSync(home, { recursive: true });
						await npmrc(home, registry);
						writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ plugins: [spec] }));
						writeFileSync(join(root, ".npmrc"), DEAD_NPMRC);
						writeFileSync(join(root, ".codework", "local.mjs"), LOCAL_PLUGIN);
						const project = [{ package: spec, options: { marker: "patched" } }, "./local.mjs"];
						writeFileSync(settings(root), JSON.stringify({ plugins: project }));

						const installed = await runAsyncResult(root, "plugin", "install", "--home", home);
						expect(installed.status, installed.stdout + installed.stderr).toBe(0);
						expect(installed.stdout).toContain("1 installed");

						// Loaded from the user file's registry, configured by the project's patch.
						const [markers] = await exchanges(home, [root]);
						expect(markers).toEqual(["[owner:patched]", "[local]"]);

						await expect(
							artifact(root, [registry.url], {
								layers: { user: [spec], project },
								install: installed.stdout,
								runtime: markers,
							}),
						).toMatchFileSnapshot("./__artifacts__/plugin-owner.patch.json");
					},
					{ source: ownerPlugin("registry") },
				);
			}),
		120_000,
	);

	it(
		"targets check and update at the configured plugin a spec names, and probes nothing else",
		() =>
			withProject(async ({ root, home }) => {
				const spec = `${NAME}@^1.0.0`;
				// A git plugin served from a repository on disk, so the git path runs with no network.
				const repo = join(root, "git-plugin");
				const commit = (revision: number) => {
					writeFileSync(
						join(repo, "package.json"),
						JSON.stringify({
							name: "fixture-git-plugin",
							version: `1.0.${revision}`,
							type: "module",
							exports: "./index.js",
						}),
					);
					writeFileSync(
						join(repo, "index.js"),
						`export default { id: "fixture.prompt.git", kind: "prompt", setup: (ctx) => ctx.plugin.prompt.set(\`\${ctx.plugin.prompt.get() ?? ""}[git:${revision}]\`) };\n`,
					);
					for (const args of [
						["add", "-A"],
						["commit", "-qm", `revision ${revision}`],
					]) {
						const done = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
						expect(done.status, done.stderr).toBe(0);
					}
				};
				mkdirSync(repo);
				const init = spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"], { encoding: "utf8" });
				expect(init.status, init.stderr).toBe(0);
				spawnSync("git", ["-C", repo, "config", "user.email", "fixture@codework.test"]);
				spawnSync("git", ["-C", repo, "config", "user.name", "fixture"]);
				commit(1);
				const git = `git+file://${repo}#main`;

				await withRegistry(
					join(root, "registry"),
					async (registry) => {
						await npmrc(root, registry);
						writeFileSync(join(root, ".codework", "local.mjs"), LOCAL_PLUGIN);
						mkdirSync(join(root, "local-package"));
						writeFileSync(
							join(root, "local-package", "package.json"),
							JSON.stringify({ name: "fixture-local-package", type: "module", main: "./index.js" }),
						);
						writeFileSync(
							join(root, "local-package", "index.js"),
							"export default { id: 'fixture.tool.package', kind: 'tool', setup() {} };\n",
						);
						writeFileSync(
							settings(root),
							JSON.stringify({ plugins: [spec, git, "./local.mjs", "../local-package"] }),
						);
						const cli = (...args: ReadonlyArray<string>) =>
							runAsyncResult(root, "plugin", ...args, "--home", home);
						/** Whether the registry was asked about the package since `mark`. */
						const asked = (mark: number) =>
							registry
								.paths()
								.slice(mark)
								.some((path) => path === `/${NAME}`);
						const steps: Array<{
							readonly command: string;
							readonly status: number | null;
							readonly stdout: string;
						}> = [];
						const step = async (...args: ReadonlyArray<string>) => {
							const result = await cli(...args);
							steps.push({ command: `plugin ${args.join(" ")}`, status: result.status, stdout: result.stdout });
							return result;
						};

						const installed = await step("install");
						expect(installed.status, installed.stdout + installed.stderr).toBe(0);
						expect(installed.stdout).toContain("2 installed, 2 local");

						// A git spec, spelled in full: only the repository is asked, never the registry.
						let mark = registry.paths().length;
						commit(2);
						const gitChecked = await step("check", git, "--refresh");
						expect(gitChecked.status).toBe(0);
						expect(gitChecked.stdout).toMatch(
							new RegExp(
								`^${git.replaceAll("+", "\\+")}  [0-9a-f]{40} -> [0-9a-f]{40}\\n1 update available\\.\\n$`,
							),
						);
						const gitUpdated = await step("update", git);
						expect(gitUpdated.status).toBe(0);
						expect(gitUpdated.stdout).toContain(`Updated ${git} to `);
						expect(gitUpdated.stdout).not.toContain(NAME);
						expect(asked(mark)).toBe(false);

						// A registry package, named without the version it was written with.
						registry.publish("1.1.0");
						mark = registry.paths().length;
						const checked = await step("check", NAME, "--refresh");
						expect(checked.status).toBe(0);
						expect(checked.stdout).toBe(`${spec}  1.0.0 -> 1.1.0\n1 update available.\n`);
						const updated = await step("update", NAME);
						expect(updated.status).toBe(0);
						expect(updated.stdout).toBe(`Updated ${spec} to 1.1.0\n1 updated.\n`);
						expect(asked(mark)).toBe(true);

						// A local plugin says why nothing happened, rather than nothing.
						const local = await step("check", "./.codework/local.mjs");
						expect(local.status).toBe(0);
						expect(local.stdout).toBe(
							`${realpathSync(root)}/.codework/local.mjs  local: no remote revision to compare\n`,
						);
						// A local package answers to the name its manifest declares, as `{ package }` does.
						const byName = await step("check", "fixture-local-package");
						expect(byName.status).toBe(0);
						expect(byName.stdout).toBe(
							`${realpathSync(root)}/local-package  local: no remote revision to compare\n`,
						);
						const localUpdate = await step("update", "./.codework/local.mjs");
						expect(localUpdate.status).toBe(0);
						expect(localUpdate.stdout).toBe(local.stdout);

						// A spec nothing configures -- and a plugin ID, which is not a spelling of the
						// `plugins` array -- fails without asking anyone anything.
						mark = registry.paths().length;
						for (const missing of ["@fixture/missing", "fixture.prompt.owner"]) {
							for (const verb of ["check", "update"]) {
								const result = await step(verb, missing);
								expect(result.status).toBe(1);
								expect(result.stdout).toBe(
									`Plugin "${missing}" is not configured. Run \`codework plugin list\` to see what is.\n`,
								);
							}
						}
						expect(registry.paths().length).toBe(mark);

						// No spec is unchanged: everything is asked about, and it is all current now.
						const everything = await step("check", "--refresh");
						expect(everything.status).toBe(0);
						expect(everything.stdout).toBe("Everything is up to date.\n");

						// The runtime runs what the targeted updates filed.
						const [markers] = await exchanges(home, [root]);
						expect(markers).toEqual(["[owner:registry]", "[git:2]", "[local]"]);

						await expect(
							artifact(root, [registry.url], { steps, runtime: markers }).replaceAll(/[0-9a-f]{40}/g, "<sha>"),
						).toMatchFileSnapshot("./__artifacts__/plugin-targeted.json");
					},
					{ source: ownerPlugin("registry") },
				);
			}),
		180_000,
	);

	it(
		"reads --user-config-dir instead of the home's settings, below the project, relative to hostCwd",
		() =>
			withProject(async ({ root, home }) => {
				/** A local plugin that leaves `[layer:<name>]`, or its options' `marker` instead. */
				const layerPlugin = (directory: string, name: string) => {
					mkdirSync(directory, { recursive: true });
					const file = join(directory, `${name}.mjs`);
					writeFileSync(
						file,
						`export default { id: "fixture.prompt.${name}", kind: "prompt", setup: (ctx, options) => ctx.plugin.prompt.set(\`\${ctx.plugin.prompt.get() ?? ""}[layer:\${options.marker ?? "${name}"}]\`) };\n`,
					);
					return file;
				};
				const write = (directory: string, plugins: ReadonlyArray<unknown>) => {
					mkdirSync(directory, { recursive: true });
					writeFileSync(join(directory, "settings.jsonc"), JSON.stringify({ plugins }));
				};
				const plugins = join(root, "plugins");
				// The home's own settings, which the override replaces.
				write(home, [layerPlugin(plugins, "home")]);
				// `./cfg` typed where the app runs (`hostCwd` = the project for a CLI run).
				const custom = join(root, "cfg");
				const user = layerPlugin(plugins, "user");
				write(custom, [user]);
				// The project still outranks the user layer: it configures the user's plugin.
				write(join(root, ".codework"), [
					layerPlugin(plugins, "project"),
					{ package: user, options: { marker: "user-from-project" } },
				]);

				const cli = (...args: ReadonlyArray<string>) =>
					runAsyncResult(root, "plugin", ...args, "--home", home, "--user-config-dir", "./cfg");
				const listed = await cli("list", "--verbose");
				expect(listed.status, listed.stderr).toBe(0);
				expect(listed.stdout).not.toContain("home.mjs");
				expect(listed.stdout).toContain(`declared in: ${realpathSync(custom)}/settings.jsonc`);

				// `-g` writes the user layer -- the override's file, never the home's.
				const homeBefore = readFileSync(join(home, "settings.jsonc"), "utf8");
				const globalAdd = await cli("add", layerPlugin(plugins, "added-user"), "-g");
				expect(globalAdd.status, globalAdd.stdout + globalAdd.stderr).toBe(0);
				expect(readFileSync(join(custom, "settings.jsonc"), "utf8")).toContain("added-user.mjs");
				expect(readFileSync(join(home, "settings.jsonc"), "utf8")).toBe(homeBefore);
				// Without `-g` the project file, as without the flag.
				const projectAdd = await cli("add", layerPlugin(plugins, "added-project"));
				expect(projectAdd.status, projectAdd.stdout + projectAdd.stderr).toBe(0);
				expect(readFileSync(settings(root), "utf8")).toContain("added-project.mjs");

				// A long-running server: the app runs from `hostCwd`, the session is linked to a
				// different `hostDir`. The relative flag resolves where the app runs; the `cfg/` under
				// the session's host directory -- where resolving against `hostDir` would land -- now
				// holds a decoy, and is never read.
				const app = mkdtempSync(join(tmpdir(), "codework-app-"));
				try {
					write(join(app, "cfg"), [user, layerPlugin(plugins, "added-user")]);
					write(custom, [layerPlugin(plugins, "decoy")]);
					const [markers] = await exchanges(home, [root], { hostCwd: app, userConfigDir: "./cfg" });
					expect(markers).toEqual([
						"[layer:user-from-project]",
						"[layer:added-user]",
						"[layer:project]",
						"[layer:added-project]",
					]);

					await expect(
						artifact(root, [], {
							list: listed.stdout,
							add: { global: globalAdd.stdout, project: projectAdd.stdout },
							runtime: markers,
						}),
					).toMatchFileSnapshot("./__artifacts__/settings-layers.json");
				} finally {
					rmSync(app, { recursive: true, force: true });
				}
			}),
		120_000,
	);

	it("skips local entries when checking for updates", () =>
		withProject(({ root, run }) => {
			// No revision to compare, so `check` reports nothing rather than calling it current.
			writeFileSync(settings(root), JSON.stringify({ plugins: [plugin("codework-tool-proc")] }));
			const checked = run("plugin", "check");
			expect(checked.status).toBe(0);
			expect(checked.stdout).toContain("Everything is up to date.");
			const updated = run("plugin", "update");
			expect(updated.status).toBe(0);
			expect(updated.stdout).toContain("Nothing to update.");
		}));
});
