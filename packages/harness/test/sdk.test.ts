import { Effect, Option } from "effect";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Sandbox } from "../src/effect/sandbox.ts";
import { Session } from "../src/effect/session.ts";
import { Global } from "../src/global.ts";
import type { LLM } from "../src/runner/llm.ts";
import { Session as SessionStore } from "../src/session/session.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { it } from "./utils/effect.ts";

const withHarness = <A, E, R>(effect: Effect.Effect<A, E, R>, llm?: LLM.Open) =>
	Effect.acquireUseRelease(
		Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-"))),
		(home) =>
			effect.pipe(
				Effect.provide(Harness.layer({ database: ":memory:", home, ...(llm === undefined ? {} : { llm }) })),
				Effect.scoped,
			),
		(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
	);

describe("Harness Effect SDK", () => {
	it.effect("creates an isolated local session with an internal id-derived slug", () =>
		withHarness(
			Effect.gen(function* () {
				const session = yield* Session.create({ title: "CLI", directory: process.cwd() });
				const info = yield* session.info;
				expect(info.id).toBe(session.id);
				expect(info.title).toBe("CLI");
				expect(info.directory).toBe(process.cwd());
				expect(info.sandbox).toBeUndefined();

				const store = yield* SessionStore.Service;
				const row = Option.getOrThrow(yield* store.get(session.id));
				expect(row.slug).toBe(session.id);
			}),
		),
	);

	it.effect("attaches a new handle to a persisted session id", () =>
		withHarness(
			Effect.gen(function* () {
				const created = yield* Session.create({ directory: process.cwd() });
				const attached = yield* Session.attach({ sessionId: created.id });
				expect(attached.id).toBe(created.id);
				expect(Option.isSome(yield* Session.get(created.id))).toBe(true);
			}),
		),
	);

	it.effect("runs a prompt to completion and continues through an attached handle", () => {
		const contexts: Parameters<typeof immediateOpen>[0] = [];
		return withHarness(
			Effect.gen(function* () {
				const created = yield* Session.create({ directory: process.cwd() });
				yield* created.run("first");
				expect((yield* created.path()).map(({ entry }) => entry.type)).toEqual(["user", "assistant"]);

				const attached = yield* Session.attach({ sessionId: created.id });
				yield* attached.run("second");
				expect((yield* attached.path()).map(({ entry }) => entry.type)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				expect(contexts).toHaveLength(2);
			}),
			immediateOpen(contexts),
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
				const runtime = () => Harness.layer({ database, home, llm });
				return Effect.gen(function* () {
					const sessionId = yield* Effect.gen(function* () {
						const session = yield* Session.create({
							directory: process.cwd(),
							model: { provider: "test", id: "test-model" },
							thinkingLevel: "max",
						});
						yield* session.run("first");
						return session.id;
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({ sessionId });
						yield* session.run("second");
						expect((yield* session.path()).map(({ entry }) => entry.type)).toEqual([
							"configChange",
							"user",
							"assistant",
							"user",
							"assistant",
						]);
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({
							sessionId,
							model: { provider: "override", id: "override-model" },
							thinkingLevel: "low",
						});
						yield* session.run("third");
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.gen(function* () {
						const session = yield* Session.attach({ sessionId });
						yield* session.run("fourth");
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					expect(contexts).toHaveLength(4);
					expect(inputs.map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel }))).toEqual(
						[
							{ provider: "test", model: "test-model", thinkingLevel: "max" },
							{ provider: "test", model: "test-model", thinkingLevel: "max" },
							{ provider: "override", model: "override-model", thinkingLevel: "low" },
							{ provider: "override", model: "override-model", thinkingLevel: "low" },
						],
					);
				});
			},
			(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
		),
	);

	it.effect("derives Global children from Harness.layer home", () =>
		Effect.acquireUseRelease(
			Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-home-"))),
			(home) =>
				Effect.gen(function* () {
					const global = yield* Global.Service;
					expect(global.home).toBe(home);
					expect(global.data).toBe(path.join(home, "data"));
				}).pipe(Effect.provide(Harness.layer({ database: ":memory:", home })), Effect.scoped),
			(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
		),
	);

	it.effect("uses each sandbox runtime default cwd unless the session overrides it", () =>
		Effect.acquireUseRelease(
			Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-sdk-sandbox-"))),
			(home) =>
				Effect.gen(function* () {
					for (const driver of ["memory", "sqldb"] as const) {
						const sandbox = yield* Sandbox.create({
							driver,
							config: { defaultCwd: "/provider-default", initializeCwd: "/provider-default" },
						});
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
						}),
					),
					Effect.scoped,
				),
			(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
		),
	);
});
