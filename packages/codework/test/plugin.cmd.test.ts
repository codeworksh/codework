/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const plugin = (name: string) => fileURLToPath(new URL(`../../../extras/${name}`, import.meta.url));

/** One temp project with its own home, so nothing here reads or writes the developer's settings. */
const withProject = (body: (project: { root: string; home: string; run: Run }) => void) => {
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
		body({ root, home, run });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};
type Run = (...args: ReadonlyArray<string>) => SpawnSyncReturns<string>;

/** The one project settings file: `<root>/.codework/settings.jsonc`. */
const settings = (root: string) => join(root, ".codework", "settings.jsonc");

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
			const directory = join(home, "cache", "plugins", createHash("sha256").update(spec).digest("hex"));
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "index.mjs"),
				"export default { id: 'acme.tool.cached', kind: 'tool', setup() {} }",
			);
			writeFileSync(
				join(directory, ".complete.json"),
				JSON.stringify({ spec, version: "1.2.0", entrypoint: "index.mjs" }),
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
				const directory = join(home, "cache", "plugins", createHash("sha256").update(spec).digest("hex"));
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "index.mjs"), `export default { id: '${id}', kind: 'tool', setup() {} }`);
				writeFileSync(
					join(directory, ".complete.json"),
					JSON.stringify({ spec, version, entrypoint: "index.mjs" }),
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
			expect(failed.stderr).toContain("phase: definition");
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
});
