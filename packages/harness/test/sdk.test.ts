import "./utils/env.ts";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Sandbox } from "../src/effect/sandbox.ts";
import { Session } from "../src/effect/session.ts";
import type { LLM } from "../src/runner/llm.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { it } from "./utils/effect.ts";

const withHarness = <A, E, R>(effect: Effect.Effect<A, E, R>, llm?: LLM.Open) =>
	Effect.acquireUseRelease(
		Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-"))),
		(home) =>
			effect.pipe(
				Effect.provide(
					Harness.layer({ database: ":memory:", home, hostCwd: home, ...(llm === undefined ? {} : { llm }) }),
				),
				Effect.scoped,
			),
		(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
	);

describe("Harness Effect SDK", () => {
	it.effect("keeps prior runtime config when attach names none", () => {
		const contexts: Parameters<typeof immediateOpen>[0] = [];
		const inputs: LLM.Input[] = [];
		const open = immediateOpen(contexts);
		const llm: LLM.Open = (input, signal) => {
			inputs.push(input);
			return open(input, signal);
		};
		return withHarness(
			Effect.gen(function* () {
				const created = yield* Session.create({
					directory: process.cwd(),
					model: { provider: "openai", id: "gpt-5.6-luna" },
					thinkingLevel: "max",
				});
				yield* created.run("first");

				// Bare re-attach in the same runtime: merges nothing, clears nothing.
				const attached = yield* Session.attach({ sessionId: created.id });
				yield* attached.run("second");

				expect(inputs.map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel }))).toEqual([
					{ provider: "openai", model: "gpt-5.6-luna", thinkingLevel: "max" },
					{ provider: "openai", model: "gpt-5.6-luna", thinkingLevel: "max" },
				]);
			}),
			llm,
		);
	});

	it.effect("reconnects by session id after the Harness runtime restarts", () =>
		Effect.acquireUseRelease(
			Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-reconnect-"))),
			(home) => {
				const database = path.join(home, "data", "sessions.db");
				const contexts: Parameters<typeof immediateOpen>[0] = [];
				const inputs: LLM.Input[] = [];
				const open = immediateOpen(contexts);
				const llm: LLM.Open = (input, signal) => {
					inputs.push(input);
					return open(input, signal);
				};
				const runtime = () => Harness.layer({ database, home, hostCwd: home, llm });
				return Effect.gen(function* () {
					const sessionId = yield* Effect.gen(function* () {
						const session = yield* Session.create({
							directory: process.cwd(),
							model: { provider: "openai", id: "gpt-5.6-luna" },
							thinkingLevel: "max",
						});
						yield* session.run("first");
						return session.id;
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({ sessionId });
						yield* session.run("second");
						expect((yield* session.path()).map(({ entry }) => entry.type)).toEqual([
							"user",
							"assistant",
							"user",
							"assistant",
						]);
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({
							sessionId,
							model: { provider: "openai", id: "gpt-5.4" },
							thinkingLevel: "low",
						});
						yield* session.run("third");
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({ sessionId });
						expect(yield* Session.configuration(sessionId)).toEqual({
							provider: "openai",
							model: "gpt-5.4",
							thinkingLevel: "low",
						});
						yield* session.run("fourth");
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					expect(contexts).toHaveLength(4);
					/*
					 * The model and thinking level are saved with the session: an attach that
					 * names none keeps what an earlier runtime chose, and one that names them
					 * replaces it for every runtime after.
					 */
					expect(inputs.map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel }))).toEqual(
						[
							{ provider: "openai", model: "gpt-5.6-luna", thinkingLevel: "max" },
							{ provider: "openai", model: "gpt-5.6-luna", thinkingLevel: "max" },
							{ provider: "openai", model: "gpt-5.4", thinkingLevel: "low" },
							{ provider: "openai", model: "gpt-5.4", thinkingLevel: "low" },
						],
					);
				});
			},
			(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
		),
	);

	it.effect("relinks a session to another checkout of the same project", () =>
		Effect.acquireUseRelease(
			Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-relink-"))),
			(base) =>
				withHarness(
					Effect.gen(function* () {
						// Two checkouts of one project: the same origin yields the same
						// project id, so a session may move between them.
						const exec = promisify(execFile);
						const a = path.join(base, "clone-a");
						const b = path.join(base, "clone-b");
						for (const dir of [a, b]) {
							yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }));
							yield* Effect.promise(() => exec("git", ["init", "-q", "-b", "main"], { cwd: dir }));
							yield* Effect.promise(() =>
								exec("git", ["remote", "add", "origin", "git@example.com:org/repo.git"], { cwd: dir }),
							);
						}
						const subA = path.join(a, "packages", "x");
						yield* Effect.promise(() => fs.mkdir(subA, { recursive: true }));
						const rootB = yield* Effect.promise(() => fs.realpath(b));

						// The rebased path exists in the target: the session keeps its
						// position under the new root.
						yield* Effect.promise(() => fs.mkdir(path.join(b, "packages", "x"), { recursive: true }));
						const session = yield* Session.create({ directory: subA });
						const moved = yield* Session.relink({ sessionId: session.id, directory: b });
						expect((yield* moved.info).directory).toBe(path.join(rootB, "packages", "x"));

						// No counterpart under the new root: the session lands on the
						// directory it was pointed at instead of stranding on a missing path.
						const orphan = path.join(a, "only-in-a");
						yield* Effect.promise(() => fs.mkdir(orphan, { recursive: true }));
						const other = yield* Session.create({ directory: orphan });
						const landed = yield* Session.relink({ sessionId: other.id, directory: b });
						expect((yield* landed.info).directory).toBe(rootB);
					}),
				),
			(base) => Effect.promise(() => fs.rm(base, { recursive: true, force: true })),
		),
	);

	it.effect("uses each sandbox runtime default cwd unless the session overrides it", () =>
		Effect.acquireUseRelease(
			Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-sandbox-"))),
			(home) =>
				Effect.gen(function* () {
					const sandboxes = yield* SandboxController.Controller;
					for (const driver of ["memory", "sqldb"] as const) {
						const sandbox = yield* Sandbox.create({
							driver,
							config: { defaultCwd: "/provider-default", initializeCwd: "/provider-default" },
						});
						// A session cwd resolves into a space, so it has to exist in the sandbox.
						yield* sandboxes.withMount(
							sandbox.id,
							Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.mkdir("/session/repo", { recursive: true })),
						);
						const defaults = yield* Session.create({ sandbox });
						const overridden = yield* Session.create({ sandbox, directory: "/session/repo" });
						expect((yield* defaults.info).directory).toBe("/provider-default");
						expect((yield* overridden.info).directory).toBe("/session/repo");
					}
				}).pipe(
					Effect.provide(
						Harness.layer({
							database: ":memory:",
							home,
							hostCwd: home,
						}),
					),
					Effect.scoped,
				),
			(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
		),
	);
});
