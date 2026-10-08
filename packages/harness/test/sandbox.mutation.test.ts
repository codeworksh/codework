import { Deferred, Effect, Fiber, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EnvNodeJSDefault } from "../src/sandbox/fs/nodejs.ts";
import { Local } from "../src/sandbox/fs/vfs.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { HostExe } from "../src/sandbox/shell/host.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

/**
 * The mutation queue is concurrency code, so it is tested in isolation, one case
 * per way it can fail:
 *   - concurrent read-modify-writes of one file lose updates
 *   - two spellings of one file (relative, absolute, through a symlinked
 *     directory) get separate queues
 *   - a file that does not exist yet, under directories that do not either,
 *     gets a different queue than later mutations of it
 *   - queued calls run out of arrival order
 *   - an interrupted waiter lets its successor overlap the running mutation
 *   - a failed mutation never releases the file
 *   - two mounts of one instance at different directories get separate queues
 *   - unrelated files wait on each other
 */

const transport = Layer.provideMerge(Layer.merge(Local.layer, HostExe.layer()), EnvNodeJSDefault.layer());

const at = (cwd: string) => SandboxIO.mount(SandboxIO.host(cwd)).pipe(Layer.provide(transport));

const settle = Effect.sleep("30 millis");

/**
 * Hold `first` open, start `second`, and report whether `second` ran while
 * `first` was still held. The two may come from different mounts.
 */
const overlaps = (first: { mount: string; path: string }, second: { mount: string; path: string }) =>
	Effect.gen(function* () {
		const gate = yield* Deferred.make<void>();
		const held = yield* Deferred.make<void>();
		let secondRan = false;
		const holder = yield* Effect.gen(function* () {
			const mutation = yield* SandboxIO.Mutation;
			yield* mutation.withFile(
				first.path,
				Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(gate))),
			);
		}).pipe(Effect.provide(at(first.mount)), Effect.forkChild);
		yield* Deferred.await(held);
		const other = yield* Effect.gen(function* () {
			const mutation = yield* SandboxIO.Mutation;
			yield* mutation.withFile(
				second.path,
				Effect.sync(() => {
					secondRan = true;
				}),
			);
		}).pipe(Effect.provide(at(second.mount)), Effect.forkChild);
		yield* settle;
		const ranWhileHeld = secondRan;
		yield* Deferred.succeed(gate, undefined);
		yield* Fiber.join(holder);
		yield* Fiber.join(other);
		return ranWhileHeld;
	});

describe("SandboxIO.Mutation", () => {
	it("serializes one file and nothing else", async () => {
		await using tmp = await tmpdir();
		// macOS resolves /var through a symlink; the queue must see through it too.
		const root = await fs.realpath(tmp.path);
		await fs.mkdir(path.join(root, "real"));
		await fs.mkdir(path.join(root, "sub"));
		await fs.symlink(path.join(root, "real"), path.join(root, "link"));
		await fs.symlink(path.join(root, "real", "file.txt"), path.join(root, "alias.txt"));
		await fs.writeFile(path.join(root, "real", "file.txt"), "0");
		await fs.writeFile(path.join(root, "counter.txt"), "0");

		const report = await Effect.runPromise(
			Effect.gen(function* () {
				// 1. Twenty concurrent increments, each yielding between its read and write.
				const increments = yield* Effect.gen(function* () {
					const mutation = yield* SandboxIO.Mutation;
					const filesystem = yield* SandboxIO.FileSystem;
					const increment = mutation.withFile(
						"counter.txt",
						Effect.gen(function* () {
							const value = Number(yield* filesystem.readFile("counter.txt"));
							yield* Effect.sleep("1 millis");
							yield* filesystem.writeFile("counter.txt", String(value + 1));
						}),
					);
					yield* Effect.all(
						Array.from({ length: 20 }, () => increment),
						{ concurrency: "unbounded" },
					);
					return Number(yield* filesystem.readFile("counter.txt"));
				}).pipe(Effect.provide(at(root)));

				// 4. Arrival order is run order.
				const order = yield* Effect.gen(function* () {
					const mutation = yield* SandboxIO.Mutation;
					const gate = yield* Deferred.make<void>();
					const ran: Array<string> = [];
					const run = (name: string, wait?: Deferred.Deferred<void>) =>
						mutation.withFile(
							"real/file.txt",
							Effect.sync(() => ran.push(name)).pipe(Effect.andThen(wait ? Deferred.await(wait) : Effect.void)),
						);
					const fibers = [yield* Effect.forkChild(run("a", gate))];
					for (const name of ["b", "c", "d", "e"]) {
						yield* settle;
						fibers.push(yield* Effect.forkChild(run(name)));
					}
					yield* settle;
					yield* Deferred.succeed(gate, undefined);
					yield* Effect.forEach(fibers, Fiber.join);
					return ran;
				}).pipe(Effect.provide(at(root)));

				// 5. Interrupting a waiter must not release the file to a later caller,
				// whether that caller queued behind it or arrived after the interrupt.
				const interruptWaiter = (lastArrives: "beforeInterrupt" | "afterInterrupt") =>
					Effect.gen(function* () {
						const mutation = yield* SandboxIO.Mutation;
						const gate = yield* Deferred.make<void>();
						const ran: Array<string> = [];
						const run = (name: string, wait?: Deferred.Deferred<void>) =>
							mutation.withFile(
								"real/file.txt",
								Effect.sync(() => ran.push(name)).pipe(
									Effect.andThen(wait ? Deferred.await(wait) : Effect.void),
								),
							);
						const a = yield* Effect.forkChild(run("a", gate));
						yield* settle;
						const b = yield* Effect.forkChild(run("b"));
						yield* settle;
						let c: Fiber.Fiber<void, unknown> | undefined;
						if (lastArrives === "beforeInterrupt") c = yield* Effect.forkChild(run("c"));
						yield* settle;
						yield* Fiber.interrupt(b);
						if (lastArrives === "afterInterrupt") c = yield* Effect.forkChild(run("c"));
						yield* settle;
						const beforeRelease = [...ran];
						yield* Deferred.succeed(gate, undefined);
						yield* Fiber.join(a);
						yield* Fiber.join(c!);
						return { beforeRelease, after: ran };
					}).pipe(Effect.provide(at(root)));
				const interrupted = {
					queuedBehind: yield* interruptWaiter("beforeInterrupt"),
					arrivedAfter: yield* interruptWaiter("afterInterrupt"),
				};

				// 6. A failed mutation releases the file.
				const afterFailure = yield* Effect.gen(function* () {
					const mutation = yield* SandboxIO.Mutation;
					const failed = yield* mutation.withFile("real/file.txt", Effect.fail("boom")).pipe(Effect.flip);
					const next = yield* mutation.withFile("real/file.txt", Effect.succeed("ran"));
					return { failed, next };
				}).pipe(Effect.provide(at(root)));

				return {
					increments,
					order,
					interrupted,
					afterFailure,
					waits: {
						// 2. Spellings of one file share a queue.
						relativeVsAbsolute: !(yield* overlaps(
							{ mount: root, path: "real/file.txt" },
							{ mount: root, path: path.join(root, "real", "file.txt") },
						)),
						throughSymlinkedDirectory: !(yield* overlaps(
							{ mount: root, path: "real/file.txt" },
							{ mount: root, path: "link/file.txt" },
						)),
						throughSymlinkedFile: !(yield* overlaps(
							{ mount: root, path: "real/file.txt" },
							{ mount: root, path: "alias.txt" },
						)),
						// 3. A file and directories that do not exist yet.
						missingThroughSymlink: !(yield* overlaps(
							{ mount: root, path: "real/new/deep/file.txt" },
							{ mount: root, path: "link/new/deep/file.txt" },
						)),
						// 7. Two mounts of one instance.
						acrossMountsOfOneInstance: !(yield* overlaps(
							{ mount: root, path: "sub/shared.txt" },
							{ mount: path.join(root, "sub"), path: "shared.txt" },
						)),
						// 8. Unrelated files.
						unrelatedFiles: !(yield* overlaps(
							{ mount: root, path: "real/file.txt" },
							{ mount: root, path: "counter.txt" },
						)),
					},
				};
			}),
		);

		expect(report.increments).toBe(20);
		expect(report.order).toEqual(["a", "b", "c", "d", "e"]);
		expect(report.interrupted).toEqual({
			queuedBehind: { beforeRelease: ["a"], after: ["a", "c"] },
			arrivedAfter: { beforeRelease: ["a"], after: ["a", "c"] },
		});
		expect(report.waits).toEqual({
			relativeVsAbsolute: true,
			throughSymlinkedDirectory: true,
			throughSymlinkedFile: true,
			missingThroughSymlink: true,
			acrossMountsOfOneInstance: true,
			unrelatedFiles: false,
		});
		await expect(JSON.stringify(report, null, "\t") + "\n").toMatchFileSnapshot(
			"./__artifacts__/sandbox.mutation.json",
		);
	});
});
