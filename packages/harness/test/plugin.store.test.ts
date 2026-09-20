import { Deferred, Effect, Exit, Fiber } from "effect";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { InstallError } from "../src/plugin/error.ts";
import type { Runner } from "../src/plugin/npm.ts";
import { parse, type Fetchable } from "../src/plugin/source.ts";
import { add, all, check, collect, remove, resolve, root } from "../src/plugin/store.ts";

/** Domain 2 against a fixture downloader. Nothing here reaches the network. */

const withCache = async (body: (cache: string) => Promise<void>) => {
	const cache = await mkdtemp(join(tmpdir(), "plugin-store-"));
	try {
		await body(cache);
	} finally {
		await rm(cache, { recursive: true, force: true });
	}
};

const fetchable = (spec: string) => Effect.runSync(parse(spec, "/unused")) as Fetchable;

/** Writes a package and reports the tree arborist would have returned. */
const fixture =
	(revision?: string): Runner =>
	({ target, into }) =>
		Effect.promise(async () => {
			const name = target.kind === "registry" ? target.name : target.slug;
			const where = join(into, "node_modules", name);
			await mkdir(where, { recursive: true });
			await writeFile(
				join(where, "package.json"),
				JSON.stringify({
					name,
					version: target.spec.endsWith("2.0.0") ? "2.0.0" : (revision ?? "1.0.0"),
					type: "module",
					exports: "./index.js",
				}),
			);
			await writeFile(
				join(where, "index.js"),
				"export default { id: 'acme.tool.fixture', kind: 'tool', setup() {} }",
			);
			return { edgesOut: new Map([[name, { to: { name, path: where } }]]) };
		});

/** The store never learns what a plugin is; every test says what "valid" means for itself. */
const accept = () => Effect.succeed("checked" as const);

const install = (spec: string, cache: string, runner: Runner = fixture(), refresh = false) =>
	add(fetchable(spec), cache, { validate: accept, runner, from: cache, ...(refresh ? { refresh: true } : {}) });

const digestOf = (spec: string) => createHash("sha256").update(spec).digest("hex");
const entryDir = (cache: string, slug: string, spec: string) => join(root(cache), slug, digestOf(spec));

describe("the store", () => {
	it("files one entry per canonical spec, and reuses it without re-running the installer", () =>
		withCache(async (cache) => {
			let runs = 0;
			const counted: Runner = (input) => {
				runs++;
				return fixture()(input);
			};
			const first = await Effect.runPromise(install("fixture@1.0.0", cache, counted));
			const again = await Effect.runPromise(install("fixture@1.0.0", cache, counted));
			const other = await Effect.runPromise(install("fixture@2.0.0", cache, counted));

			expect(first.entry.url).toBe(again.entry.url);
			expect(first.entry.version).toBe("1.0.0");
			expect(other.entry.version).toBe("2.0.0");
			// Identity is the canonical spec, so two versions of one plugin are two entries side
			// by side -- which is why one shared store needs no per-project copy.
			expect(first.entry.digest).not.toBe(other.entry.digest);
			expect(runs).toBe(2);

			// The second call came off the fast path: nothing was staged, so nothing was checked.
			expect(first.validated).toBe("checked");
			expect(again.validated).toBeUndefined();
		}));

	it("lays the entry out as slug, digest and generation", () =>
		withCache(async (cache) => {
			const added = await Effect.runPromise(install("fixture@1.0.0", cache));
			const directory = entryDir(cache, "fixture", "fixture@1.0.0");

			// A readable slug is greppable; the full digest is what actually separates entries, so
			// a collision can never return the wrong package.
			expect(existsSync(directory)).toBe(true);
			expect(digestOf("fixture@1.0.0")).toHaveLength(64);
			expect((await readdir(directory)).filter((name) => /^\d+$/.test(name))).toEqual([
				String(added.entry.generation),
			]);
			expect(existsSync(join(directory, String(added.entry.generation), ".complete.json"))).toBe(true);
		}));

	it("records an entrypoint that stays inside the published generation", () =>
		withCache(async (cache) => {
			// Node resolution realpaths its answer while a staging directory does not, so a
			// symlinked cache root used to record a path outside the entry.
			const added = await Effect.runPromise(install("fixture", cache));
			const file = fileURLToPath(added.entry.url);
			expect(existsSync(file)).toBe(true);
			expect(relative(root(cache), file).startsWith("..")).toBe(false);
		}));

	it("keeps the plugin out of what it files", () =>
		withCache(async (cache) => {
			const added = await Effect.runPromise(install("fixture@1.0.0", cache));
			const directory = join(entryDir(cache, "fixture", "fixture@1.0.0"), String(added.entry.generation));
			const marker: unknown = JSON.parse(await readFile(join(directory, ".complete.json"), "utf8"));

			// Every field is the spec, or something package.json said, or a timestamp. The moment a
			// marker holds an `id`, the on-disk format encodes the result of running code the store
			// is meant to be indifferent to.
			expect(Object.keys(marker as object).sort()).toEqual([
				"createdAt",
				"entrypoint",
				"name",
				"revision",
				"spec",
				"version",
			]);
			// What validation learned rides back to the caller instead.
			expect(added.validated).toBe("checked");
		}));

	it("publishes nothing when validation rejects what was staged", () =>
		withCache(async (cache) => {
			const rejected = await Effect.runPromise(
				add(fetchable("fixture"), cache, {
					runner: fixture(),
					from: cache,
					validate: () =>
						Effect.fail(
							new InstallError({
								reason: "plugin-no-entrypoint",
								reference: "fixture@latest",
								message: "not a plugin",
							}),
						),
				}).pipe(Effect.flip),
			);
			expect(rejected.reason).toBe("plugin-no-entrypoint");

			// Validating after publishing would make the broken generation the newest marked one,
			// which `resolve` returns forever after -- and the claimed rollback would have nothing
			// to roll back to.
			expect(await Effect.runPromise(resolve(fetchable("fixture"), cache))).toBeUndefined();
			// And the next install is not blocked by the wreckage of the last.
			expect((await Effect.runPromise(install("fixture", cache))).entry.version).toBe("1.0.0");
		}));

	it("publishes a new generation when a refresh finds a different revision, and keeps the old one", () =>
		withCache(async (cache) => {
			const first = await Effect.runPromise(install("fixture", cache, fixture("1.0.0")));
			const moved = await Effect.runPromise(install("fixture", cache, fixture("1.1.0"), true));

			expect(moved.entry.generation).toBeGreaterThan(first.entry.generation);
			// A different path, because Node's ESM registry is keyed by URL and never evicts: an
			// in-place update would hand back the old module on the next import.
			expect(moved.entry.url).not.toBe(first.entry.url);
			// The previous generation survives, so an exchange already holding URLs into it is
			// not disturbed.
			expect(existsSync(fileURLToPath(first.entry.url))).toBe(true);
			expect((await Effect.runPromise(resolve(fetchable("fixture"), cache)))?.version).toBe("1.1.0");
		}));

	it("throws away a refresh that found the same revision", () =>
		withCache(async (cache) => {
			const first = await Effect.runPromise(install("fixture", cache, fixture("1.0.0")));
			const same = await Effect.runPromise(install("fixture", cache, fixture("1.0.0"), true));

			// Publishing a redundant generation would grow the store and the module registry on
			// every update of an unchanged branch.
			expect(same.entry.generation).toBe(first.entry.generation);
			const directory = entryDir(cache, "fixture", "fixture@latest");
			expect((await readdir(directory)).filter((name) => /^\d+$/.test(name))).toHaveLength(1);
		}));

	it("keeps the available revision when an outdated check is served from the TTL cache", () =>
		withCache(async (cache) => {
			const target = fetchable("fixture");
			await Effect.runPromise(install("fixture", cache, fixture("1.0.0")));
			let probes = 0;
			const probe = () => {
				probes++;
				return Effect.succeed("1.1.0");
			};

			const first = await Effect.runPromise(check(target, cache, { probe }));
			const cached = await Effect.runPromise(check(target, cache, { probe }));

			expect(first).toEqual({ _tag: "outdated", filed: "1.0.0", available: "1.1.0" });
			expect(cached).toEqual(first);
			expect(probes).toBe(1);
		}));

	it("answers from the index, and repairs it when it disagrees with disk", () =>
		withCache(async (cache) => {
			const added = await Effect.runPromise(install("fixture@1.0.0", cache));
			const index = join(root(cache), "index.json");
			expect(existsSync(index)).toBe(true);

			// Deleting the accelerator must always be safe: the markers are the truth it is
			// derived from, so a scan rebuilds it.
			await rm(index);
			const scanned = await Effect.runPromise(resolve(fetchable("fixture@1.0.0"), cache));
			expect(scanned?.url).toBe(added.entry.url);
			expect(existsSync(index)).toBe(true);

			// And an index that points at a generation which is not there loses to disk.
			await writeFile(
				index,
				JSON.stringify({
					version: 1,
					entries: {
						[digestOf("fixture@1.0.0")]: {
							spec: "fixture@1.0.0",
							source: "registry",
							name: "fixture",
							slug: "fixture",
							mutable: false,
							generation: 1,
							entrypoint: "node_modules/fixture/index.js",
							installedAt: 1,
						},
					},
				}),
			);
			expect((await Effect.runPromise(resolve(fetchable("fixture@1.0.0"), cache)))?.url).toBe(added.entry.url);
		}));

	it("treats an unreadable index as a cold cache rather than a failure", () =>
		withCache(async (cache) => {
			const added = await Effect.runPromise(install("fixture@1.0.0", cache));
			await writeFile(join(root(cache), "index.json"), "{ not json");
			expect((await Effect.runPromise(resolve(fetchable("fixture@1.0.0"), cache)))?.url).toBe(added.entry.url);
		}));

	it("keeps the two newest generations and expires what is older", () =>
		withCache(async (cache) => {
			const directory = entryDir(cache, "fixture", "fixture@latest");
			await Effect.runPromise(install("fixture", cache));
			const day = 24 * 60 * 60 * 1000;
			const old = String(Date.now() - 8 * day);
			const recent = String(Date.now() - 1000);
			for (const generation of [old, recent]) {
				await mkdir(join(directory, generation), { recursive: true });
			}
			// A crashed installer's staging directory, aged past an hour.
			const staged = join(directory, ".staging-crashed");
			await mkdir(staged, { recursive: true });
			const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
			await utimes(staged, hoursAgo, hoursAgo);

			await Effect.runPromise(collect(directory));
			const left = await readdir(directory);
			// The newest is live and the one before it may still be imported by an exchange in
			// flight, so both survive regardless of age.
			expect(left).toContain(recent);
			expect(left).not.toContain(old);
			expect(left).not.toContain(".staging-crashed");
		}));

	it("drops a whole entry on remove, and forgets it in the index", () =>
		withCache(async (cache) => {
			await Effect.runPromise(install("fixture@1.0.0", cache));
			expect(await Effect.runPromise(remove(fetchable("fixture@1.0.0"), cache))).toBe(true);
			expect(await Effect.runPromise(resolve(fetchable("fixture@1.0.0"), cache))).toBeUndefined();
			// Removing something that was never there is not an error.
			expect(await Effect.runPromise(remove(fetchable("fixture@1.0.0"), cache))).toBe(false);
		}));

	it("lists what is filed, without importing anything", () =>
		withCache(async (cache) => {
			await Effect.runPromise(install("fixture@1.0.0", cache));
			await Effect.runPromise(install("fixture@2.0.0", cache));
			const listed = await Effect.runPromise(all(cache));
			expect(listed.map((entry) => entry.spec).sort()).toEqual(["fixture@1.0.0", "fixture@2.0.0"]);
		}));
});

describe("the store's lock", () => {
	const lockOf = (cache: string, spec: string) => join(entryDir(cache, "fixture", spec), ".lock");

	it("reads a published entry without waiting on a leftover lock", () =>
		withCache(async (cache) => {
			const first = await Effect.runPromise(install("fixture", cache));
			// A killed installer leaves its lock behind; a hit must not block on it.
			await mkdir(lockOf(cache, "fixture@latest"), { recursive: true });
			const again = await Effect.runPromise(
				install("fixture", cache).pipe(Effect.timeout("2 seconds"), Effect.orDie),
			);
			expect(again.entry.url).toBe(first.entry.url);
		}));

	it("reclaims a lock abandoned by a crashed installer instead of timing out", () =>
		withCache(async (cache) => {
			// The crash left a lock but no published generation, so the only way forward is to
			// take it over. Aged past the timeout; a fresh one would still be waited on.
			const lock = lockOf(cache, "fixture@latest");
			await mkdir(lock, { recursive: true });
			const old = new Date(Date.now() - 3 * 60_000);
			await utimes(lock, old, old);

			const added = await Effect.runPromise(
				install("fixture", cache).pipe(Effect.timeout("5 seconds"), Effect.orDie),
			);
			expect(added.entry.version).toBe("1.0.0");
			expect(existsSync(lock)).toBe(false);
		}));

	it("keeps waiting on a live lock rather than stealing it", () =>
		withCache(async (cache) => {
			const lock = lockOf(cache, "fixture@latest");
			await mkdir(lock, { recursive: true });
			const exit = await Effect.runPromiseExit(install("fixture", cache).pipe(Effect.timeout("300 millis")));
			expect(Exit.isFailure(exit)).toBe(true);
			// Staleness is measured from the heartbeat, so a slow but live install is never stolen.
			expect(existsSync(lock)).toBe(true);
		}));

	it("leaves neither staging nor lock behind when interrupted mid-install", () =>
		withCache(async (cache) => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const stuck: Runner = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
					const fiber = yield* install("fixture", cache, stuck).pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					yield* Fiber.interrupt(fiber);
				}).pipe(Effect.scoped),
			);
			const directory = entryDir(cache, "fixture", "fixture@latest");
			expect(await readdir(directory)).toEqual([]);
			// And the next installer finds a clean slate rather than a lock to wait on.
			expect((await Effect.runPromise(install("fixture", cache))).entry.version).toBe("1.0.0");
		}));

	it("serializes concurrent installs and permits cancellation while waiting", () =>
		withCache(async (cache) => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					let runs = 0;
					const gated: Runner = (input) =>
						Effect.gen(function* () {
							runs++;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							return yield* fixture()(input);
						});
					const first = yield* install("fixture", cache, gated).pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					const waiting = yield* install("fixture", cache, gated).pipe(Effect.forkChild);
					yield* Effect.yieldNow;
					yield* Fiber.interrupt(waiting);
					const second = yield* install("fixture", cache, gated).pipe(Effect.forkChild);
					yield* Deferred.succeed(release, undefined);
					// The loser of the race adopts the winner's generation rather than installing
					// a second identical copy.
					expect((yield* Fiber.join(first)).entry.url).toBe((yield* Fiber.join(second)).entry.url);
					expect(runs).toBe(1);
				}).pipe(Effect.scoped),
			);
		}));
});
