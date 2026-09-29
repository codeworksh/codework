import { Effect } from "effect";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { prepare, type Options, type PluginRef, type Prepared } from "../src/plugin/catalog.ts";
import { canonical } from "../src/plugin/loader.ts";
import { canonical as canonicalOf, type Fetchable, parse, type Target } from "../src/plugin/source.ts";
import { define } from "../src/plugin/plugin.ts";

const a = define({ id: "acme.tool.a", kind: "tool", setup: () => {} });
const b = define({ id: "acme.tool.b", kind: "tool", setup: () => {} });
const options: Options = { builtins: [], cache: "/unused", hostDir: "/project" };

/** `parse` is pure behind its Effect, so a test can read the Target out directly. */
const target = (spec: string, from = "/project"): Target => Effect.runSync(parse(spec, from));
const fetchable = (spec: string) => target(spec) as Exclude<Target, { kind: "local" }>;
const named = (spec: string, from = "/project") => Effect.runSync(canonical(spec, from));
/** `prepare` pairs each selected plugin with its configuration; most assertions want the plugins. */
const selected = (list: ReadonlyArray<Prepared>) => list.map((entry) => entry.plugin);
const run = (references: ReadonlyArray<PluginRef>, overrides: Partial<Options> = {}) =>
	Effect.runPromise(prepare(references, { ...options, ...overrides }));
const withDirectory = async (body: (directory: string) => Promise<void>) => {
	const directory = await mkdtemp(join(tmpdir(), "plugin-catalog-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};
describe("plugin catalog and source resolution", () => {
	it("reduces every spelling of one module to a single canonical name", () => {
		// What `plugin add` records and what `plugin remove` is given are rarely the same string:
		// a version is pinned on the way in and dropped on the way out, and a relative path means
		// nothing until it is anchored to the file that declared it.
		expect(named("@acme/codework-tool-proc@1.2.0", "/project")).toBe("@acme/codework-tool-proc");
		expect(named("@acme/codework-tool-proc", "/project")).toBe("@acme/codework-tool-proc");
		expect(named("proc@^2", "/project")).toBe("proc");
		expect(named("proc@latest", "/project")).toBe("proc");
		expect(named("./plugins/x.ts", "/project")).toBe("/project/plugins/x.ts");
		expect(named("/project/plugins/x.ts", "/elsewhere")).toBe("/project/plugins/x.ts");
		expect(named("file:///project/plugins/x.ts", "/elsewhere")).toBe("/project/plugins/x.ts");
		// A plugin ID is not a module reference; it has to survive unchanged to compare as itself.
		expect(named("acme.tool.proc", "/project")).toBe("acme.tool.proc");
	});

	it("resolves last definitions and last module order without setup", async () => {
		let calls = 0;
		const latest = define({
			id: a.id,
			kind: "tool",
			setup: () => {
				calls++;
			},
		});
		const result = await run([a, b, latest]);
		// The last definition of an ID wins, and moves it: a module entry owns its position.
		expect(selected(result).map((p) => p.id)).toEqual([b.id, a.id]);
		expect(result[1]?.plugin.setup).toBe(latest.setup);
		expect(result[1]?.options).toEqual({});
		expect(calls).toBe(0);
	});
	it("ignores configuration for a plugin nothing selected", async () => {
		const ignored = [
			{ plugin: "acme.tool.missing", options: { one: 1 } },
			{ plugin: "acme.tool.missing", enabled: false },
			{ package: "@acme/never-installed", options: { one: 1 } },
			{ package: "./plugins/local.ts", enabled: false },
			// The right name under the wrong key is just another name nothing answers to.
			{ package: a.id, options: { one: 1 } },
			{ plugin: "@acme/plugin", options: { one: 1 } },
		];
		// Nothing fails, nothing installs, nothing imports — a build that does not ship a plugin
		// reads a file configuring it and carries on.
		const installs: string[] = [];
		expect(
			selected(
				await run([a, ...ignored], {
					install: (request) => {
						installs.push(request.spec);
						return Effect.succeed({ url: "file:///x.js", version: "1.0.0" });
					},
				}),
			),
		).toEqual([a]);
		expect(installs).toEqual([]);
		// Configuration addresses the selection as it stands, so an entry preceding its module
		// has nothing to apply to either.
		expect((await run([{ plugin: a.id, options: { one: 1 } }, a]))[0]?.options).toEqual({});
	});
	it("disables a selected plugin by ID or by the package it came from", async () => {
		const seams = {
			install: () => Effect.succeed({ url: "file:///fixture.js", version: "1.0.0" }),
			import: async () => ({ default: b }),
		};
		expect(selected(await run([a, b, { plugin: a.id, enabled: false }]))).toEqual([b]);
		expect(await run([a, { plugin: a.id, enabled: false }])).toEqual([]);
		// Re-listing the module selects it again, at its new position.
		expect(selected(await run([a, b, { plugin: a.id, enabled: false }, a]))).toEqual([b, a]);
		expect(
			selected(await run(["@acme/plugin@1.2.0", a, { package: "@acme/plugin", enabled: false }], seams)),
		).toEqual([a]);
	});
	it("addresses a loaded module by its package name, its spec or its path", async () => {
		const seams = {
			install: () => Effect.succeed({ url: "file:///fixture.js", version: "1.0.0" }),
			import: async () => ({ default: a }),
		};
		const [byName] = await run(["@acme/plugin@1.2.0", { package: "@acme/plugin", options: { one: 1 } }], seams);
		expect(byName?.plugin).toBe(a);
		expect(byName?.options).toEqual({ one: 1 });
		const [bySpec] = await run(["@acme/plugin@1.2.0", { package: "@acme/plugin@1.2.0", enabled: false }], seams);
		expect(bySpec).toBeUndefined();
		const [byId] = await run(["@acme/plugin@1.2.0", { plugin: a.id, options: { two: 2 } }], seams);
		expect(byId?.options).toEqual({ two: 2 });
		// A module entry is always a source, so a second spec of the same package loads again.
		let installs = 0;
		await run(["@acme/plugin@1.2.0", "@acme/plugin@2.0.0"], {
			...seams,
			install: () => {
				installs++;
				return Effect.succeed({ url: "file:///fixture.js", version: "1.0.0" });
			},
		});
		expect(installs).toBe(2);
	});
	it("treats an ID as a key: the last module owns it, and the configuration written against it", async () => {
		// Two modules exporting one ID is the author's conflict to resolve, not the harness's to
		// arbitrate. The ID is the key: the later definition wins, and configuration written
		// against that key stays with it — including a name the replaced module was loaded under.
		const fromA = define({ id: "acme.tool.same", kind: "tool", setup: () => {} });
		const fromB = define({ id: "acme.tool.same", kind: "tool", setup: () => {} });
		const seams = {
			install: (target: Fetchable) => Effect.succeed({ url: `file:///${canonicalOf(target)}.js`, version: "1.0.0" }),
			import: async (url: string) => ({ default: url.includes("pkg-a") ? fromA : fromB }),
		};
		const [replaced] = await run(["pkg-a@1.0.0", { package: "pkg-a", options: { one: 1 } }, "pkg-b@1.0.0"], seams);
		expect(replaced?.plugin).toBe(fromB);
		expect(replaced?.options).toEqual({ one: 1 });
		// And the last block written against the key wins, whichever name addressed it.
		const [configured] = await run(
			[
				"pkg-a@1.0.0",
				"pkg-b@1.0.0",
				{ package: "pkg-a", options: { one: 1 } },
				{ plugin: "acme.tool.same", options: { two: 2 } },
			],
			seams,
		);
		expect(configured?.plugin).toBe(fromB);
		expect(configured?.options).toEqual({ two: 2 });
	});
	it("rejects a contradictory configuration entry", async () => {
		// A settings file is decoded before it reaches `prepare`; an embedder's array is not, so
		// the entry shape is checked here for both.
		for (const entry of [
			{ plugin: a.id, package: "@acme/x" },
			{ options: { one: 1 } },
			{ plugin: "", options: {} },
			{ plugin: a.id, enabled: "yes" },
			{ plugin: a.id, options: "nope" },
			// An object to `typeof`, but not the string-keyed record `options` is documented to be.
			// `Object.freeze` throws on a typed array, which would defect past this error handling.
			{ plugin: a.id, options: new Uint8Array([1]) },
			{ plugin: a.id, options: new Map([["one", 1]]) },
			{ plugin: a.id, options: [1, 2] },
		]) {
			const error = await Effect.runPromise(prepare([a, entry as never], options).pipe(Effect.flip));
			expect(error).toMatchObject({ reason: "plugin-invalid-definition" });
		}
	});
	it("carries per-plugin options, replaces repeated blocks and never reorders", async () => {
		const [first, second] = await run([
			a,
			b,
			{ plugin: a.id, options: { one: 1, endpoint: "old" } },
			{ plugin: a.id, options: { two: 2, endpoint: null } },
		]);
		// Configuration leaves position alone: `a` still runs where its module entry put it.
		expect(first?.plugin).toBe(a);
		expect(second?.plugin).toBe(b);
		// The block is opaque, so the last one owns it whole — including values a settings-style
		// merge would drop, such as an explicit null.
		expect(first?.options).toEqual({ two: 2, endpoint: null });
		expect(second?.options).toEqual({});
		expect(Object.isFrozen(first?.options)).toBe(true);
		// Re-listing the module moves it and keeps the configuration it was given.
		const moved = await run([a, { plugin: a.id, options: { one: 1 } }, b, a]);
		expect(selected(moved).map((plugin) => plugin.id)).toEqual([b.id, a.id]);
		expect(moved[1]?.options).toEqual({ one: 1 });
	});
	it("seeds builtins without selecting them and reserves their namespace", async () => {
		const builtin = define({ id: "codework.tool.fixture", kind: "tool", setup: () => {} });
		expect(await run([], { builtins: [builtin] })).toEqual([]);
		// The registered definition itself selects it, and is not a redefinition of it.
		expect(selected(await run([builtin], { builtins: [builtin] }))).toEqual([builtin]);
		// Configuration cannot select: a built-in nothing listed stays unselected.
		expect(await run([{ plugin: builtin.id, options: { one: 1 } }], { builtins: [builtin] })).toEqual([]);
		expect(await Effect.runPromise(prepare([builtin], options).pipe(Effect.flip))).toMatchObject({
			reason: "plugin-invalid-definition",
		});
	});
	it("reads a definition carrying its own `plugin` property as a definition", async () => {
		// `Plugin` permits extra properties and the loader preserves them, so the entry check
		// cannot be "has a `plugin` key".
		const plugin = { id: "acme.tool.meta", kind: "tool", plugin: "metadata", setup: () => {} };
		expect(selected(await run([plugin]))).toEqual([plugin]);
	});
	it("reports a malformed supplied object as a typed definition failure", async () => {
		// Nothing has validated the entry yet, so `origin.reference` cannot read an `id` off it --
		// and a JavaScript caller can pass a value that has no properties to read at all.
		for (const input of [{}, [], () => a, { id: 123, setup: () => {} }, null, undefined]) {
			const error = await Effect.runPromise(prepare([b, input as never], options).pipe(Effect.flip));
			expect(error).toMatchObject({ reason: "plugin-invalid-definition" });
			expect(typeof error.reference).toBe("string");
		}
	});
	it("selects the caller's own object rather than a validated copy", async () => {
		// A `Struct` decode would return a clone holding only `id`/`setup`, which breaks both
		// object identity and `this` inside the documented `setup() {}` shorthand.
		const seen: string[] = [];
		const plugin = {
			id: "acme.tool.self",
			kind: "tool" as const,
			label: "kept",
			setup() {
				seen.push((this as { label: string }).label);
			},
		};
		const [resolved] = await run([plugin]);
		expect(resolved?.plugin).toBe(plugin);
		void resolved?.plugin.setup({} as never, {});
		expect(seen).toEqual(["kept"]);
	});
	it("normalizes package specs and tells a path from a package from a git source", () => {
		expect(target("@acme/plugin")).toEqual({
			kind: "registry",
			name: "@acme/plugin",
			spec: "@acme/plugin@latest",
			mutable: true,
		});
		// `@acme/x` and `@acme/x@latest` must become one string before anything hashes them, or
		// they file as two store entries holding identical bytes.
		expect(target("@acme/plugin@latest")).toEqual(target("@acme/plugin"));
		expect(fetchable("@acme/plugin@1.2.0").spec).toBe("@acme/plugin@1.2.0");
		expect(fetchable("plugin@*").spec).toBe("plugin@*");
		// A trailing bare `@` is no version at all, not the `*` range npa reports for it.
		expect(target("plugin@")).toEqual(target("plugin"));

		// Mutability decides whether `check` has anything to do, and is the only thing that
		// justifies a network call.
		expect(fetchable("@acme/plugin@1.2.0").mutable).toBe(false);
		expect(fetchable("@acme/plugin@^1").mutable).toBe(true);

		expect(target("./plugin.ts", "/project")).toEqual({ kind: "local", path: "/project/plugin.ts" });
		expect(target("file:///project/plugin.ts", "/elsewhere")).toEqual({
			kind: "local",
			path: "/project/plugin.ts",
		});
		// A reference is a source and nothing else: an ID-shaped string is a package name here,
		// and the plugin it names is addressed by `{ plugin: "acme.tool.a" }` instead.
		expect(target(a.id).kind).toBe("registry");
		expect(target(`${a.id}@latest`)).toEqual(target(a.id));
		expect(target("acme.tool.deep.name").kind).toBe("registry");
		// A `~` reference is a path: npa would read `~` as a package and `~/x` as a bad spec.
		expect(target("~/plugins/one.ts")).toEqual({ kind: "local", path: join(homedir(), "plugins/one.ts") });
		expect(target("~")).toEqual({ kind: "local", path: homedir() });
		// `fileURLToPath` would silently turn this into `/rel.ts`.
		expect(Effect.runSync(Effect.flip(parse("file:./rel.ts", "/project"))).reason).toBe("plugin-unsupported-source");
		// Unversioned, unauthenticated, no update story. npa parses it, so the refusal is explicit.
		expect(Effect.runSync(Effect.flip(parse("https://example.com/plugin.tgz", "/project"))).reason).toBe(
			"plugin-unsupported-source",
		);
	});

	it("reads a git source's committish, subdirectory and mutability", () => {
		const branch = target("github:acme/plugins#main");
		expect(branch).toMatchObject({ kind: "git", slug: "plugins", committish: "main", mutable: true });

		// A commit SHA names one artifact, so it can never go stale and is never re-probed.
		const sha = "a".repeat(40);
		expect(target(`git+https://example.com/acme/p.git#${sha}`)).toMatchObject({ kind: "git", mutable: false });
		// An abbreviated one is not a commit: it is a ref that could resolve elsewhere later.
		expect(fetchable("git+https://example.com/acme/p.git#a1b2c3d").mutable).toBe(true);

		// `::path:` selects a package inside a monorepo, which the installer handles for us.
		expect(target("github:acme/plugins#main::path:packages/tool-proc")).toMatchObject({
			kind: "git",
			subdir: "/packages/tool-proc",
		});

		// The slug is for a human reading `ls`, never an identity -- the digest separates two
		// remotes that happen to end in the same name.
		const ssh = target("git+ssh://git@github.com/acme/plugins.git#main");
		expect(ssh.kind === "git" && ssh.slug).toBe("plugins");
	});

	it("loads each normalized source once and validates default exports", async () => {
		let installs = 0;
		let imports = 0;
		const seams = {
			...options,
			install: () => {
				installs++;
				return Effect.succeed({ url: "file:///fixture.js", version: "1.0.0" });
			},
			import: async () => {
				imports++;
				return { default: a };
			},
		};
		expect(
			selected(await Effect.runPromise(prepare(["@acme/plugin", "@acme/plugin@latest", { plugin: a.id }], seams))),
		).toEqual([a]);
		expect(installs).toBe(1);
		expect(imports).toBe(1);
		expect(
			await Effect.runPromise(
				prepare(["@acme/plugin"], { ...seams, import: async () => ({ plugin: a }) }).pipe(Effect.flip),
			),
		).toMatchObject({ reason: "plugin-invalid-definition", reference: "@acme/plugin" });
	});
	it("resolves local directory import conditions and reports broken exports as source errors", () =>
		withDirectory(async (directory) => {
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name: "fixture", exports: { ".": { import: "./entry.js", require: "./wrong.cjs" } } }),
			);
			await writeFile(join(directory, "entry.js"), "");
			let url = "";
			expect(
				selected(
					await run([directory], {
						import: async (input) => {
							url = input;
							return { default: a };
						},
					}),
				),
			).toEqual([a]);
			// Containment compares real paths, so the exported URL is the real one too.
			expect(url).toBe(pathToFileURL(realpathSync(join(directory, "entry.js"))).href);
			// Node caches package manifests; a different package exercises invalid exports.
			const broken = join(directory, "broken");
			await mkdir(broken);
			await writeFile(
				join(broken, "package.json"),
				JSON.stringify({ name: "broken", exports: { "./other": "./entry.js" } }),
			);
			expect(await Effect.runPromise(prepare([broken], options).pipe(Effect.flip))).toMatchObject({
				reason: "plugin-not-found",
				reference: broken,
			});
		}));
	it("falls back to index.js and reports a directory with no entry as a source error", () =>
		withDirectory(async (directory) => {
			const empty = join(directory, "empty");
			await mkdir(empty);
			expect(await Effect.runPromise(prepare([empty], options).pipe(Effect.flip))).toMatchObject({
				reason: "plugin-not-found",
				reference: empty,
			});
			await writeFile(join(empty, "index.js"), "");
			let url = "";
			await Effect.runPromise(
				prepare([empty], {
					...options,
					import: async (input) => {
						url = input;
						return { default: a };
					},
				}),
			);
			expect(url).toBe(pathToFileURL(realpathSync(join(empty, "index.js"))).href);
		}));
	it("requires a package name for native local export resolution", () =>
		withDirectory(async (directory) => {
			await writeFile(join(directory, "package.json"), JSON.stringify({ exports: "./entry.js" }));
			await writeFile(join(directory, "entry.js"), "");
			const error = await Effect.runPromise(prepare([directory], options).pipe(Effect.flip));
			expect(error).toMatchObject({ _tag: "PluginSourceError", reason: "plugin-escapes-root" });
			expect(error.message).toContain("must declare its name");
		}));
	it("rejects a root export that only nests by symlink", () =>
		withDirectory(async (directory) => {
			// The manifest points at `./entry.js`, which sits inside the package by name but is a
			// symlink to a file outside it. String containment passes; real-path containment must not.
			const outside = join(directory, "outside.js");
			const pkg = join(directory, "pkg");
			await mkdir(pkg);
			await writeFile(outside, "export default { id: 'acme.tool.escaped', kind: 'tool', setup() {} }");
			await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "pkg", exports: "./entry.js" }));
			await symlink(outside, join(pkg, "entry.js"));
			const error = await Effect.runPromise(prepare([pkg], options).pipe(Effect.flip));
			expect(error).toMatchObject({ _tag: "PluginSourceError", reason: "plugin-escapes-root" });
			expect(error.message).toContain("escapes its root");
		}));
});
