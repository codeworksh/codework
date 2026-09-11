import { Deferred, Effect, Fiber } from "effect";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { prepare } from "../src/plugin/catalog.ts";
import { classify, validate } from "../src/plugin/loader.ts";
import { install, InstallError, parse, type Runner } from "../src/plugin/package.ts";
import { define } from "../src/plugin/plugin.ts";

const a = define({ id: "acme.tool.a", setup: () => {} });
const b = define({ id: "acme.tool.b", setup: () => {} });
const options = { builtins: [], cache: "/unused", hostCwd: "/project" };
const withDirectory = async (body: (directory: string) => Promise<void>) => {
	const directory = await mkdtemp(join(tmpdir(), "plugin-catalog-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};
const fixture: Runner = (request, directory) =>
	Effect.tryPromise({
		try: async () => {
			const root = join(directory, "node_modules", request.name);
			await mkdir(root, { recursive: true });
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({
					name: request.name,
					version: request.spec.endsWith("2.0.0") ? "2.0.0" : "1.0.0",
					type: "module",
					exports: "./index.js",
				}),
			);
			await writeFile(join(root, "index.js"), "export default { id: 'acme.tool.fixture', setup() {} }");
		},
		catch: (cause) => new InstallError({ cause }),
	});

describe("plugin catalog and source resolution", () => {
	it("resolves forward IDs, last definitions and last operation order without setup", async () => {
		let calls = 0;
		const latest = define({
			id: a.id,
			setup: () => {
				calls++;
			},
		});
		const result = await Effect.runPromise(prepare([a.id, a, b, latest, b.id], options));
		expect(result.map((p) => p.id)).toEqual([a.id, b.id]);
		expect(result[0]?.setup).toBe(latest.setup);
		expect(calls).toBe(0);
	});
	it("disables unknown IDs and re-enables known IDs", async () => {
		expect(await Effect.runPromise(prepare([a, b, `!${a.id}`, "!acme.tool.unknown", a.id], options))).toEqual([b, a]);
		expect(await Effect.runPromise(prepare([a, `!${a.id}`], options))).toEqual([]);
		const error = await Effect.runPromise(prepare([a.id], options).pipe(Effect.flip));
		expect(error).toMatchObject({ phase: "resolve", index: 0, reference: a.id, id: a.id });
	});
	it("seeds builtins without selecting them and reserves their namespace", async () => {
		const builtin = define({ id: "codework.tool.fixture", setup: () => {} });
		expect(await Effect.runPromise(prepare([], { ...options, builtins: [builtin] }))).toEqual([]);
		expect(await Effect.runPromise(prepare([builtin.id], { ...options, builtins: [builtin] }))).toEqual([builtin]);
		expect(await Effect.runPromise(prepare([builtin], options).pipe(Effect.flip))).toMatchObject({
			phase: "definition",
		});
	});
	it.each([{}, [], () => a, { setup: () => {} }, { id: "invalid", setup: () => {} }, { id: a.id, setup: 1 }])(
		"rejects malformed definitions: %j",
		async (input) => {
			expect(
				await Effect.runPromise(validate(input, { index: 2, reference: "fixture" }).pipe(Effect.flip)),
			).toMatchObject({ phase: "definition", index: 2 });
		},
	);
	it("reports a malformed supplied object as a typed definition failure", async () => {
		// Nothing has validated the entry yet, so `origin.reference` cannot read an `id` off it.
		for (const input of [{}, [], () => a, { id: 123, setup: () => {} }]) {
			const error = await Effect.runPromise(prepare([b, input as never], options).pipe(Effect.flip));
			expect(error).toMatchObject({ phase: "definition", index: 1 });
			expect(typeof error.reference).toBe("string");
		}
	});
	it("selects the caller's own object rather than a validated copy", async () => {
		// A `Struct` decode would return a clone holding only `id`/`setup`, which breaks both
		// object identity and `this` inside the documented `setup() {}` shorthand.
		const seen: string[] = [];
		const plugin = {
			id: "acme.tool.self",
			label: "kept",
			setup() {
				seen.push((this as { label: string }).label);
			},
		};
		const [resolved] = await Effect.runPromise(prepare([plugin], options));
		expect(resolved).toBe(plugin);
		void resolved?.setup({} as never);
		expect(seen).toEqual(["kept"]);
	});
	it("normalizes package specs and classifies local sources", () => {
		expect(parse("@acme/plugin")).toEqual({ name: "@acme/plugin", spec: "@acme/plugin@latest" });
		expect(parse("@acme/plugin@latest")).toEqual(parse("@acme/plugin"));
		expect(parse("@acme/plugin@1.2.0").spec).toBe("@acme/plugin@1.2.0");
		expect(parse("plugin@*").spec).toBe("plugin@*");
		// A trailing bare `@` is no version at all, not the `*` range npa reports for it.
		expect(parse("plugin@")).toEqual(parse("plugin"));
		expect(classify("./plugin.ts", "/project")).toEqual({ kind: "local", path: "/project/plugin.ts" });
		expect(classify("file:///project/plugin.ts", "/elsewhere")).toEqual({
			kind: "local",
			path: "/project/plugin.ts",
		});
		expect(classify(a.id, "/project")).toEqual({ kind: "id", id: a.id });
		// A dotted package name needs an explicit version to be read as a package.
		expect(classify(`${a.id}@latest`, "/project")).toEqual({ kind: "package", request: parse(`${a.id}@latest`) });
		// An ID is exactly three segments; a fourth belongs to a package name.
		expect(classify("acme.tool.deep.name", "/project").kind).toBe("package");
		expect(classify(`!${a.id}`, "/project")).toEqual({ kind: "disable", id: a.id });
		expect(() => classify("!", "/project")).toThrow();
		// `fileURLToPath` would silently turn this into `/rel.ts`.
		expect(() => classify("file:./rel.ts", "/project")).toThrow();
		expect(() => parse("https://example.com/plugin.tgz")).toThrow();
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
		expect(await Effect.runPromise(prepare(["@acme/plugin", "@acme/plugin@latest", a.id], seams))).toEqual([a]);
		expect(installs).toBe(1);
		expect(imports).toBe(1);
		expect(
			await Effect.runPromise(
				prepare(["@acme/plugin"], { ...seams, import: async () => ({ plugin: a }) }).pipe(Effect.flip),
			),
		).toMatchObject({ phase: "definition", reference: "@acme/plugin" });
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
				await Effect.runPromise(
					prepare([directory], {
						...options,
						import: async (input) => {
							url = input;
							return { default: a };
						},
					}),
				),
			).toEqual([a]);
			expect(url).toBe(pathToFileURL(join(directory, "entry.js")).href);
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name: "fixture", exports: { "./other": "./entry.js" } }),
			);
			expect(await Effect.runPromise(prepare([directory], options).pipe(Effect.flip))).toMatchObject({
				phase: "source",
				index: 0,
				reference: directory,
			});
		}));
	it("falls back to index.js and reports a directory with no entry as a source error", () =>
		withDirectory(async (directory) => {
			const empty = join(directory, "empty");
			await mkdir(empty);
			expect(await Effect.runPromise(prepare([empty], options).pipe(Effect.flip))).toMatchObject({
				phase: "source",
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
			expect(url).toBe(pathToFileURL(join(empty, "index.js")).href);
		}));
	it("resolves a manifest without exports through legacy main", () =>
		withDirectory(async (directory) => {
			await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture", main: "./legacy.js" }));
			await writeFile(join(directory, "legacy.js"), "");
			let url = "";
			await Effect.runPromise(
				prepare([directory], {
					...options,
					import: async (input) => {
						url = input;
						return { default: a };
					},
				}),
			);
			// The legacy branch resolves through `createRequire`, which realpaths its answer.
			expect(url).toBe(pathToFileURL(realpathSync(join(directory, "legacy.js"))).href);
		}));
	it("stages installs, reuses complete cache and isolates explicit versions", () =>
		withDirectory(async (cache) => {
			let runs = 0;
			const runner: Runner = (request, directory) => {
				runs++;
				return fixture(request, directory);
			};
			const first = await Effect.runPromise(install(parse("fixture@1.0.0"), cache, runner));
			const again = await Effect.runPromise(install(parse("fixture@1.0.0"), cache, runner));
			const second = await Effect.runPromise(install(parse("fixture@2.0.0"), cache, runner));
			expect(first).toEqual(again);
			expect(first.version).toBe("1.0.0");
			expect(second.version).toBe("2.0.0");
			expect(first.url).not.toBe(second.url);
			expect(runs).toBe(2);
			expect(first.url).toContain("/plugins/");
			expect(await readdir(cache)).toEqual(["plugins"]);
		}));
	it("records an entrypoint inside the published installation", () =>
		withDirectory(async (cache) => {
			// `import-meta-resolve` realpaths its answer while the staging directory is not
			// realpathed, so a symlinked cache root used to record a path outside the entry.
			const installed = await Effect.runPromise(install(parse("fixture"), cache, fixture));
			const file = fileURLToPath(installed.url);
			expect(existsSync(file)).toBe(true);
			expect(relative(join(cache, "plugins"), file).startsWith("..")).toBe(false);
		}));
	it("reads a complete cache without waiting on a leftover lock", () =>
		withDirectory(async (cache) => {
			const first = await Effect.runPromise(install(parse("fixture"), cache, fixture));
			// A killed installer leaves its lock directory behind; a cache hit must not block on it.
			const stale = (await readdir(join(cache, "plugins"))).map((entry) => join(cache, "plugins", `${entry}.lock`));
			await Promise.all(stale.map((lock) => mkdir(lock, { recursive: true })));
			expect(
				await Effect.runPromise(
					install(parse("fixture"), cache, fixture).pipe(Effect.timeout("2 seconds"), Effect.orDie),
				),
			).toEqual(first);
		}));
	it("does not reuse failed installations", () =>
		withDirectory(async (cache) => {
			const failed = await Effect.runPromise(
				install(parse("fixture"), cache, () => Effect.fail(new InstallError({ cause: new Error("offline") }))).pipe(
					Effect.flip,
				),
			);
			expect(failed._tag).toBe("PluginInstallError");
			expect(await readdir(join(cache, "plugins"))).toEqual([]);
			expect((await Effect.runPromise(install(parse("fixture"), cache, fixture))).version).toBe("1.0.0");
		}));
	it("serializes concurrent installs and permits cancellation while waiting for the lock", () =>
		withDirectory(async (cache) => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					let runs = 0;
					const runner: Runner = (request, directory) =>
						Effect.gen(function* () {
							runs++;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							yield* fixture(request, directory);
						});
					const first = yield* install(parse("fixture"), cache, runner).pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					const waiting = yield* install(parse("fixture"), cache, runner).pipe(Effect.forkChild);
					yield* Effect.yieldNow;
					yield* Fiber.interrupt(waiting);
					const second = yield* install(parse("fixture"), cache, runner).pipe(Effect.forkChild);
					yield* Deferred.succeed(release, undefined);
					expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
					expect(runs).toBe(1);
				}).pipe(Effect.scoped),
			);
		}));
});

it("imports an actual local module default export", () =>
	withDirectory(async (directory) => {
		const source = join(directory, "plugin.mjs");
		await writeFile(source, "export default { id: 'acme.tool.local', setup() {} }");
		const plugins = await Effect.runPromise(prepare([source], options));
		expect(plugins.map((plugin) => plugin.id)).toEqual(["acme.tool.local"]);
	}));
