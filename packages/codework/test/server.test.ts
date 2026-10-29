/* @effect-diagnostics nodeBuiltinImport:off -- fixtures only need temp dirs. */
/* @effect-diagnostics globalFetch:off -- the integration suite calls its local test server. */
/* @effect-diagnostics globalFetchInEffect:off -- the integration suite calls its local test server. */
import { Event, EventList, EventSchema, Harness, Sandbox, Session } from "@codeworksh/harness/effect";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpServer } from "effect/http";
import { RpcTest } from "effect/rpc";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { define as definePlugin } from "../../harness/src/plugin/plugin.ts";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { Client } from "../src/server/client.ts";
import { Contract } from "../src/server/contract.ts";
import { Envelope } from "../src/server/envelope.ts";
import { EventFeed } from "../src/server/feed.ts";
import { Handlers } from "../src/server/handlers.ts";
import { Identity } from "../src/server/identity.ts";
import { OAuth } from "../src/server/oauth.ts";
import { Server } from "../src/server/server.ts";
import { linkedDirectory } from "../src/cli/cmd/handlers/plugin/session.ts";

process.env.CODEWORK_MODELS_FILE ??= fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const execCli = async (args: ReadonlyArray<string>, cwd?: string) => {
	try {
		const result = await exec(process.execPath, ["--conditions=development", cli, ...args], {
			...(cwd === undefined ? {} : { cwd }),
			timeout: 10_000,
		});
		return { status: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
		return {
			status: failure.code ?? 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
};

const homes: string[] = [];
const layer = (options: Harness.Options = {}) => {
	const home = mkdtempSync(join(tmpdir(), "codework-server-"));
	homes.push(home);
	return Handlers.layer.pipe(
		Layer.provide(EventFeed.layer),
		Layer.provide(OAuth.layer({ home })),
		Layer.provide(Identity.layer),
		Layer.provideMerge(Harness.layer({ home, hostCwd: home, database: ":memory:", ...options })),
	);
};

/** A plugin whose event the server is told about up front. */
const Registered = EventSchema.define({
	type: "plugin.test.event.registrar.noticed",
	schema: { value: Schema.String },
});
const registrar = definePlugin({ id: "test.event.registrar", kind: "tool", events: [Registered], setup: () => {} });

afterAll(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("server", () => {
	it("sandbox.drivers returns the core drivers", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const drivers = yield* rpc["sandbox.drivers"]({});
			expect(drivers.map(({ name }) => name)).toEqual(expect.arrayContaining(["memory", "sqldb"]));
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("session.create + thread.info + thread.list round-trip", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			expect(created.session.id.startsWith("ses")).toBe(true);
			expect(created.id.startsWith("thr")).toBe(true);
			expect(created.session.mainThreadId).toBe(created.id);
			expect(created.origin).toEqual({ kind: "main" });
			expect(created.title).toBeUndefined();

			const info = yield* rpc["thread.info"]({ sessionId: created.session.id });
			expect(info.id).toBe(created.id);
			expect((yield* rpc["thread.info"]({ sessionId: created.session.id, threadId: created.id })).id).toBe(
				created.id,
			);

			const listed = yield* rpc["thread.list"]({});
			expect(listed.some(({ id }) => id === created.id)).toBe(true);
			expect((yield* rpc["thread.list"]({ sessionId: created.session.id })).map(({ id }) => id)).toEqual([
				created.id,
			]);
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("uses the harness hostCwd for a local session when the client omits directory", () => {
		const hostCwd = realpathSync(mkdtempSync(join(tmpdir(), "codework-server-cwd-")));
		homes.push(hostCwd);
		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			expect(created.session.directory).toBe(hostCwd);
		}).pipe(Effect.scoped, Effect.provide(layer({ hostCwd })), Effect.runPromise);
	});

	it("session.create honours a client-supplied hostDir, and omits it when the client named none", () => {
		const root = mkdtempSync(join(tmpdir(), "codework-server-hostdir-"));
		homes.push(root);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			// Passed through as given. The client is the owner of this machine, so naming a host
			// path is no more privilege than running `codework` in it.
			const placed = yield* rpc["session.create"]({ hostDir: Session.AbsolutePath.make(root) });
			expect(placed.session.hostDir).toBe(root);
			expect((yield* rpc["thread.info"]({ sessionId: placed.session.id })).session.hostDir).toBe(root);

			// And nothing fills it in: a session the client did not place has no host project,
			// rather than quietly adopting the server's own startup directory.
			const unplaced = yield* rpc["session.create"]({});
			expect(unplaced.session.hostDir).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise);
	});

	it("session.link sets and clears a session's host directory", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-server-link-")));
		homes.push(root);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			expect(created.session.hostDir).toBeUndefined();

			const linked = yield* rpc["session.link"]({
				sessionId: created.session.id,
				hostDir: Session.AbsolutePath.make(root),
			});
			expect(linked.hostDir).toBe(root);
			// Stored, not held in the call: a later reader sees it too.
			expect((yield* rpc["thread.info"]({ sessionId: created.session.id })).session.hostDir).toBe(root);

			// Omitting the field clears the anchor, leaving the session with no host directory.
			const cleared = yield* rpc["session.link"]({ sessionId: created.session.id });
			expect(cleared.hostDir).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise);
	});

	it("refuses to write a project for a session that has none", () => {
		// The session exists and is perfectly usable; it just has no project to write into. That
		// is a normal state, and the one `session link` exists to fix.
		const home = mkdtempSync(join(tmpdir(), "codework-server-unlinked-"));
		homes.push(home);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			const failure = yield* linkedDirectory(created.session.id, Option.some(home)).pipe(Effect.flip);
			expect(failure).toMatchObject({ _tag: "SessionNotLinkedError", reason: "session-not-linked" });

			// Linked, the same lookup answers with the directory.
			yield* rpc["session.link"]({
				sessionId: created.session.id,
				hostDir: Session.AbsolutePath.make(realpathSync(home)),
			});
			expect(yield* linkedDirectory(created.session.id, Option.some(home))).toBe(realpathSync(home));
		}).pipe(
			Effect.scoped,
			// A file database, because the lookup opens its own connection the way the CLI does.
			Effect.provide(layer({ home, database: join(home, "data", "codework.db") })),
			Effect.runPromise,
		);
	});

	it("refuses a relative host directory rather than resolving it against its own", () => {
		const home = mkdtempSync(join(tmpdir(), "codework-server-relative-"));
		homes.push(home);

		return expect(
			Effect.gen(function* () {
				const rpc = yield* RpcTest.makeClient(Contract.Api);
				const created = yield* rpc["session.create"]({});
				/*
				 * A client means *its own* `my-project`. The only directory the server could
				 * resolve that against is the one it was started in, which would store a real path
				 * on the wrong machine's filesystem -- branded absolute, persisted, and used to
				 * pick the settings file whose plugins this process then imports. Measured before
				 * it was fixed: `my-project` came back as `<the server's repository>/my-project`.
				 */
				yield* rpc["session.link"]({
					sessionId: created.session.id,
					// Deliberately bypass the client type to prove the wire decoder rejects malformed input.
					hostDir: "my-project" as Session.AbsolutePath,
				});
			}).pipe(Effect.scoped, Effect.provide(layer({ home, hostCwd: home })), Effect.runPromise),
		).rejects.toThrow(/Schema validation failed/);
	});

	it("anchors a plugin reference to the session's project, not the directory the CLI ran in", () => {
		const home = mkdtempSync(join(tmpdir(), "codework-server-linked-"));
		homes.push(home);
		const project = join(realpathSync(home), "project");
		const elsewhere = join(realpathSync(home), "elsewhere");
		mkdirSync(join(project, ".codework"), { recursive: true });
		mkdirSync(join(project, "tool"), { recursive: true });
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(
			join(project, "tool", "package.json"),
			JSON.stringify({ name: "local-tool", type: "module", exports: "./index.js" }),
		);
		writeFileSync(
			join(project, "tool", "index.js"),
			'export default { id: "acme.tool.local", kind: "tool", setup() {} };\n',
		);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			yield* rpc["session.link"]({ sessionId: created.session.id, hostDir: Session.AbsolutePath.make(project) });

			/*
			 * `--session` exists for a server or a UI acting on a session's behalf, so the shell's
			 * directory is not the project and often is not a project at all. Every question this
			 * command asks about the reference has to be asked of the same directory: `./tool`
			 * exists under the session's project and nowhere near `elsewhere`, so a command that
			 * anchored to its own cwd would fail to find it -- and one that anchored `parse` and
			 * the written entry differently would import one file and record another.
			 */
			yield* Effect.promise(() =>
				exec(
					process.execPath,
					[
						"--conditions=development",
						cli,
						"plugin",
						"add",
						"./tool",
						"--session",
						created.session.id,
						"--home",
						home,
					],
					{
						cwd: elsewhere,
					},
				),
			);

			const written = readFileSync(join(project, ".codework", "settings.jsonc"), "utf8");
			// Relative to the settings file that holds it, which is `<project>/.codework/`.
			expect(written).toContain('"../tool"');
		}).pipe(
			Effect.scoped,
			Effect.provide(layer({ home, database: join(home, "data", "codework.db") })),
			Effect.runPromise,
		);
	}, 120_000);

	it("plugin.reload reports the loaded set", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const reloaded = yield* rpc["plugin.reload"]({});
			// The built-ins alone are a set, so a server with no configured plugins still reloads.
			expect(reloaded.plugins).toBeGreaterThan(0);
			expect(reloaded.failure).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("thread.info fails with SessionNotFoundError for a bogus session and ThreadNotFoundError for a bogus thread", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const failure = yield* rpc["thread.info"]({
				sessionId: Session.SessionSchema.ID.ascending("ses_nope"),
			}).pipe(Effect.flip);
			expect(failure._tag).toBe("SessionNotFoundError");

			const other = yield* rpc["session.create"]({});
			const created = yield* rpc["session.create"]({});
			// A real thread of another session is still not this session's.
			const foreign = yield* rpc["thread.info"]({ sessionId: created.session.id, threadId: other.id }).pipe(
				Effect.flip,
			);
			expect(foreign._tag).toBe("ThreadNotFoundError");
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("session.create and session.relink report invalid directories", () => {
		const root = mkdtempSync(join(tmpdir(), "codework-server-directory-"));
		homes.push(root);
		const file = join(root, "file");
		writeFileSync(file, "not a directory");

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const sandbox = yield* rpc["sandbox.create"]({ driver: "memory" });
			const missingError = yield* rpc["session.create"]({
				directory: "missing",
				sandbox: { id: sandbox.id },
			}).pipe(Effect.flip);
			expect(missingError).toMatchObject({
				_tag: "Location.DirectoryNotFoundError",
				directory: "/missing",
				sandboxInstanceId: sandbox.id,
			});

			const fileError = yield* rpc["session.create"]({ directory: file }).pipe(Effect.flip);
			expect(fileError).toMatchObject({
				_tag: "Location.NotDirectoryError",
				directory: file,
				sandboxInstanceId: Sandbox.SandboxInstance.ID.local,
			});

			const session = yield* rpc["session.create"]({ directory: root });
			const relinkError = yield* rpc["session.relink"]({
				sessionId: session.session.id,
				directory: "missing",
				sandbox: { id: sandbox.id },
			}).pipe(Effect.flip);
			expect(relinkError).toMatchObject({
				_tag: "Location.DirectoryNotFoundError",
				directory: "/missing",
				sandboxInstanceId: sandbox.id,
			});
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise);
	});

	it("event.subscribe streams envelopes that decode through the registry", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const admitted = yield* rpc["event.subscribe"]({}).pipe(
				Stream.filter((envelope) => envelope.type === EventList.PromptAdmitted.type),
				Stream.runHead,
				Effect.forkChild,
			);

			const session = yield* rpc["session.create"]({});
			yield* rpc["thread.prompt"]({ sessionId: session.session.id, text: "hello" });

			const envelope = yield* Fiber.join(admitted).pipe(Effect.timeout("10 seconds"));
			expect(Option.isSome(envelope)).toBe(true);
			const decoded = yield* Envelope.decode(Option.getOrThrow(envelope));
			expect(decoded.type).toBe(EventList.PromptAdmitted.type);
			expect(decoded.data).toMatchObject({ sessionId: session.session.id, threadId: session.id });
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("skips plugin events while keeping the subscription alive", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const events = yield* Event.Service;
			const queue = yield* rpc["event.subscribe"]({}).pipe(Stream.toQueue({ capacity: 16 }));
			expect((yield* Queue.take(queue)).type).toBe(Envelope.Connected.type);
			yield* events.publish(EventSchema.define({ type: "plugin.test.custom", schema: { value: Schema.String } }), {
				value: "hello",
			});
			yield* events.publish(EventList.ExecutionSucceeded, {
				sessionId: Session.SessionSchema.ID.create(),
				threadId: Session.ThreadSchema.ID.create(),
				timestamp: yield* DateTime.now,
			});
			expect((yield* Queue.take(queue)).type).toBe(EventList.ExecutionSucceeded.type);
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.timeout("3 seconds"), Effect.runPromise));

	it("delivers a plugin event the server was told about", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const events = yield* Event.Service;
			const queue = yield* rpc["event.subscribe"]({}).pipe(Stream.toQueue({ capacity: 16 }));
			expect((yield* Queue.take(queue)).type).toBe(Envelope.Connected.type);

			yield* events.publish(Registered, { value: "hello" });

			// Registration is what makes it encodable, and therefore sendable.
			const envelope = yield* Queue.take(queue);
			expect(envelope.type).toBe(Registered.type);
			expect(envelope.data).toEqual({ value: "hello" });
			const registry: Envelope.Registry = (type) => (type === Registered.type ? Registered : Envelope.Core(type));
			const decoded = yield* Envelope.decode(envelope, registry);
			expect(Schema.is(Registered)(decoded)).toBe(true);
			if (Schema.is(Registered)(decoded)) expect(decoded.data.value).toBe("hello");
		}).pipe(
			Effect.scoped,
			Effect.provide(layer({ plugins: [registrar] })),
			Effect.timeout("3 seconds"),
			Effect.runPromise,
		));

	it("reuses sandbox ids for creation and relinking without stopping them on failure", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const sandbox = yield* rpc["sandbox.create"]({ driver: "memory" });
			const first = yield* rpc["session.create"]({ sandbox: { id: sandbox.id } });
			const second = yield* rpc["session.create"]({ sandbox: { id: sandbox.id } });
			expect(first.session.sandbox?.id).toBe(sandbox.id);
			expect(second.session.sandbox?.id).toBe(sandbox.id);
			const relinked = yield* rpc["session.relink"]({ sessionId: first.session.id, sandbox: { id: sandbox.id } });
			expect(relinked.sandbox?.id).toBe(sandbox.id);
			yield* rpc["session.relink"]({
				sessionId: Session.SessionSchema.ID.create(),
				sandbox: { id: sandbox.id },
			}).pipe(Effect.flip);
			const listed = yield* rpc["sandbox.list"]({});
			expect(listed.filter((item) => item.driver === "memory")).toHaveLength(1);
			expect(listed.find((item) => item.id === sandbox.id)?.status).toBe(sandbox.status);
			const missing = yield* rpc["session.create"]({
				sandbox: { id: Sandbox.SandboxInstance.ID.make("missing") },
			}).pipe(Effect.flip);
			expect(missing._tag).toBe("SandboxNotFoundError");
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("names a session's project on creation, keeps it once created, and renames it", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-server-project-")));
		homes.push(root);
		const dir = (name: string) => {
			const path = join(root, name);
			mkdirSync(path);
			return path;
		};
		const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
		const repo = async (path: string, origin: string) => {
			await git(path, "init", "-q", "-b", "main");
			await git(path, "config", "user.email", "test@codework.sh");
			await git(path, "config", "user.name", "Codework Test");
			await git(path, "remote", "add", "origin", `https://github.com/org/${origin}`);
			writeFileSync(join(path, "a.txt"), "a\n");
			await git(path, "add", "a.txt");
			await git(path, "commit", "-q", "-m", "init");
			return path;
		};

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const projectOf = (sessionId: Session.SessionSchema.ID) =>
				rpc["thread.info"]({ sessionId }).pipe(Effect.map((info) => info.session.project));
			const nameOf = (sessionId: Session.SessionSchema.ID) =>
				projectOf(sessionId).pipe(Effect.map((project) => project?.name));

			// 1. Memory sandbox: the given name, otherwise the empty name it has today.
			const memoryNamed = yield* rpc["session.create"]({
				sandbox: { driver: "memory" },
				project: { name: "In Memory" },
			});
			const memoryUnnamed = yield* rpc["session.create"]({ sandbox: { driver: "memory" } });

			// 2. Plain folder: the given name beats the basename.
			const folderNamed = yield* rpc["session.create"]({
				directory: dir("plain-named"),
				project: { name: "Plain" },
			});
			const folderUnnamed = yield* rpc["session.create"]({ directory: dir("plain-unnamed") });

			// 3. Git repo: the given name beats the repository's identity name (the origin's, not the folder's).
			// One origin per repo: a shared remote is a shared project.
			const checkout = yield* Effect.promise(() => repo(dir("checkout"), "named-upstream"));
			const repoNamed = yield* rpc["session.create"]({ directory: checkout, project: { name: "Repo" } });
			const other = yield* Effect.promise(() => repo(dir("other-checkout"), "upstream"));
			const repoUnnamed = yield* rpc["session.create"]({ directory: other });

			// 4. An existing project keeps its name.
			const shared = dir("shared");
			const first = yield* rpc["session.create"]({ directory: shared, project: { name: "A" } });
			const second = yield* rpc["session.create"]({ directory: shared, project: { name: "B" } });
			const firstProject = yield* projectOf(first.session.id);
			const secondProject = yield* projectOf(second.session.id);
			expect(secondProject?.id).toBe(firstProject?.id);

			// 5. Rename shows through every session of the project.
			const renamed = yield* rpc["project.rename"]({ projectId: firstProject?.id ?? "", name: "C" });
			const missing = yield* rpc["project.rename"]({ projectId: "prj_missing", name: "C" }).pipe(Effect.flip);
			expect(missing).toMatchObject({ _tag: "ProjectNotFoundError", projectId: "prj_missing" });

			// 6. Invalid names are refused at the edge and create nothing.
			const before = (yield* rpc["thread.list"]({})).length;
			const outcome = (exit: Exit.Exit<unknown, unknown>) =>
				Exit.isFailure(exit) && String(exit.cause).includes("Schema validation failed") ? "rejected" : String(exit);
			const invalid: Record<string, { create: string; rename: string }> = {};
			for (const [label, name] of [
				["empty", ""],
				["blank", "   "],
				["padded", " padded "],
			] as const) {
				const create = yield* rpc["session.create"]({ directory: shared, project: { name } }).pipe(Effect.exit);
				const rename = yield* rpc["project.rename"]({ projectId: firstProject?.id ?? "", name }).pipe(Effect.exit);
				invalid[label] = {
					create: outcome(create),
					rename: outcome(rename),
				};
			}
			const after = (yield* rpc["thread.list"]({})).length;
			expect(after).toBe(before);

			const artifact = {
				memory: { named: yield* nameOf(memoryNamed.session.id), unnamed: yield* nameOf(memoryUnnamed.session.id) },
				folder: { named: yield* nameOf(folderNamed.session.id), unnamed: yield* nameOf(folderUnnamed.session.id) },
				repo: { named: yield* nameOf(repoNamed.session.id), unnamed: yield* nameOf(repoUnnamed.session.id) },
				existing: {
					first: firstProject?.name,
					second: secondProject?.name,
					sameProject: secondProject?.id === firstProject?.id,
				},
				rename: {
					result: { sameId: renamed.id === firstProject?.id, name: renamed.name },
					first: yield* nameOf(first.session.id),
					second: yield* nameOf(second.session.id),
					missing: { _tag: missing._tag, projectId: missing.projectId },
				},
				invalid,
				sessionsCreatedByInvalid: after - before,
			};
			expect(artifact.memory).toEqual({ named: "In Memory", unnamed: "" });
			expect(artifact.folder).toEqual({ named: "Plain", unnamed: "plain-unnamed" });
			expect(artifact.repo).toEqual({ named: "Repo", unnamed: "upstream" });
			expect(artifact.existing).toEqual({ first: "A", second: "A", sameProject: true });
			expect(artifact.rename).toMatchObject({ first: "C", second: "C", result: { sameId: true, name: "C" } });
			for (const outcome of Object.values(invalid))
				expect(outcome).toEqual({ create: "rejected", rename: "rejected" });
			return artifact;
		})
			.pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise)
			.then((artifact) =>
				expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/server.project-name.json",
				),
			);
	}, 60_000);

	it("model.list lists credentialed providers and the settings default, per project", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-server-models-")));
		homes.push(root);
		const project = join(root, "project");
		const broken = join(root, "broken");
		mkdirSync(join(project, ".codework"), { recursive: true });
		mkdirSync(join(broken, ".codework"), { recursive: true });
		writeFileSync(
			join(project, ".codework", "settings.jsonc"),
			JSON.stringify({
				model: { provider: "local", id: "qwen3-coder:30b" },
				models: [
					{
						id: "qwen3-coder:30b",
						name: "Qwen3 Coder 30B",
						provider: { id: "local", name: "Local", source: "config", env: [] },
						baseUrl: "http://127.0.0.1:1/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32768,
						maxTokens: 8192,
						protocol: "openai-compatible",
					},
				],
			}),
		);
		writeFileSync(join(broken, ".codework", "settings.jsonc"), "{ not json");

		// Every key the catalog names is blanked, so the developer's own keys cannot change the
		// answer; one fake key shows the env path. The test home holds no OAuth login.
		const catalog: Record<string, Record<string, { provider: { env?: string[]; key?: string } }>> = JSON.parse(
			readFileSync(process.env.CODEWORK_MODELS_FILE ?? "", "utf8"),
		);
		for (const entries of Object.values(catalog))
			for (const { provider } of Object.values(entries))
				for (const name of [...(provider.env ?? []), ...(provider.key ? [provider.key] : [])]) vi.stubEnv(name, "");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const user = yield* rpc["model.list"]({});
			const scoped = yield* rpc["model.list"]({ hostDir: Session.AbsolutePath.make(project) });
			const invalid = yield* rpc["model.list"]({ hostDir: Session.AbsolutePath.make(broken) }).pipe(Effect.flip);

			const ids = (providers: ReadonlyArray<{ readonly id: string }>) => providers.map(({ id }) => id).sort();
			const artifact = {
				user: { providers: ids(user.providers), default: user.default },
				project: {
					providers: ids(scoped.providers),
					local: scoped.providers.find(({ id }) => id === "local"),
					default: scoped.default,
				},
				invalid: {
					_tag: invalid._tag,
					message: invalid.message.replaceAll(root, "<root>"),
				},
			};
			expect(artifact.user.default).toMatchObject({
				provider: "openai",
				id: "gpt-5.6-luna",
				thinkingLevel: "medium",
			});
			expect(artifact.user.default.providerName).toBe("OpenAI");
			expect(artifact.user.providers).toContain("anthropic");
			expect(artifact.user.providers).not.toContain("local");
			expect(artifact.project.local).toEqual({
				id: "local",
				name: "Local",
				models: [{ id: "qwen3-coder:30b", name: "Qwen3 Coder 30B", thinkingLevels: ["off"] }],
			});
			expect(artifact.project.default).toEqual({
				provider: "local",
				id: "qwen3-coder:30b",
				thinkingLevel: "medium",
				name: "Qwen3 Coder 30B",
				providerName: "Local",
			});
			expect(invalid._tag).toBe("SettingsError");
			return artifact;
		})
			.pipe(
				Effect.scoped,
				Effect.provide(layer()),
				Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
				Effect.runPromise,
			)
			.then((artifact) =>
				expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/server.model-list.json",
				),
			);
	});

	it("thread.message reports an unknown prompt as absent", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const session = yield* rpc["session.create"]({});
			const found = yield* rpc["thread.message"]({
				sessionId: session.session.id,
				messageId: Session.SessionMessageSchema.ID.create(),
			});
			expect(found.found).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));
});

const websocket = (options: Harness.Options = {}) => {
	const home = mkdtempSync(join(tmpdir(), "codework-ws-"));
	homes.push(home);
	return Server.layer({
		host: "127.0.0.1",
		port: 0,
		harness: { home, hostCwd: home, database: ":memory:", plugins: [], llm: immediateOpen(), ...options },
	});
};

const connectedClient = Effect.gen(function* () {
	const server = yield* HttpServer.HttpServer;
	if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
	const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${server.address.port}/rpc/v1`));
	return yield* Client.make.pipe(Effect.provideContext(context));
});

describe("WebSocket client", () => {
	it("stores OpenAI Codex credentials explicitly over RPC", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const provider = "openai-codex" as const;
			expect(yield* rpc["auth.status"]({ provider })).toBeNull();
			expect(
				yield* rpc["auth.save"]({
					credentials: {
						provider,
						access: "access-token",
						refresh: "refresh-token",
						expires: 4_102_444_800_000,
						accountId: "acct_server",
					},
				}),
			).toMatchObject({ provider, accountId: "acct_server", expires: 4_102_444_800_000 });
			expect(yield* rpc["auth.status"]({ provider })).toMatchObject({
				provider,
				accountId: "acct_server",
				expires: 4_102_444_800_000,
			});
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("keeps GitHub Copilot and OpenAI Codex logins side by side", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			yield* rpc["auth.save"]({
				credentials: {
					provider: "openai-codex",
					access: "codex-token",
					refresh: "codex-refresh",
					expires: 4_102_444_800_000,
					accountId: "acct_server",
				},
			});
			expect(
				yield* rpc["auth.save"]({
					credentials: {
						provider: "github-copilot",
						access: "ghu_token",
						refresh: "ghu_token",
						expires: 0,
						apiEndpoint: "https://api.individual.githubcopilot.com",
						availableModelIds: ["gpt-5.4", "claude-opus-5"],
					},
				}),
			).toMatchObject({
				provider: "github-copilot",
				expires: 0,
				apiEndpoint: "https://api.individual.githubcopilot.com",
				availableModels: 2,
			});

			// One auth.json holds both providers; clearing one leaves the other.
			yield* rpc["auth.logout"]({ provider: "github-copilot" });
			expect(yield* rpc["auth.status"]({ provider: "github-copilot" })).toBeNull();
			expect(yield* rpc["auth.status"]({ provider: "openai-codex" })).toMatchObject({ accountId: "acct_server" });
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("model.list keeps only the Copilot models the login can reach", () => {
		// The env token would make Copilot an API-key provider, which is never filtered.
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
		return Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const copilotModels = () =>
				rpc["model.list"]({}).pipe(
					Effect.map(({ providers }) =>
						(providers.find(({ id }) => id === "github-copilot")?.models ?? []).map(({ id }) => id).sort(),
					),
				);
			const before = yield* copilotModels();
			yield* rpc["auth.save"]({
				credentials: {
					provider: "github-copilot",
					access: "ghu_token",
					refresh: "ghu_token",
					expires: 0,
					apiEndpoint: "https://api.individual.githubcopilot.com",
					availableModelIds: ["gpt-6-luna", "claude-sonnet-5.5", "not-in-the-catalog"],
				},
			});
			const after = yield* copilotModels();
			expect(before).toEqual([]);
			expect(after).toEqual(["claude-sonnet-5.5", "gpt-6-luna"]);
			return { before, after };
		})
			.pipe(
				Effect.scoped,
				Effect.provide(websocket()),
				Effect.timeout("10 seconds"),
				Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
				Effect.runPromise,
			)
			.then((artifact) =>
				expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/server.model-list-copilot.json",
				),
			);
	});

	it("refreshes server OpenAI Codex credentials", () => {
		const nativeFetch = globalThis.fetch.bind(globalThis);
		const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const access = `${encode({ alg: "none", typ: "JWT" })}.${encode({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_server" },
		})}.signature`;
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "https://auth.openai.com/oauth/token") {
				return Response.json({ access_token: access, refresh_token: "refresh-token", expires_in: 3600 });
			}
			return nativeFetch(input, init);
		});

		return Effect.gen(function* () {
			const rpc = yield* connectedClient;
			yield* rpc["auth.save"]({
				credentials: {
					provider: "openai-codex",
					access: "expired",
					refresh: "old-refresh",
					expires: 0,
					accountId: "acct_old",
				},
			});
			expect(yield* rpc["auth.refresh"]({ provider: "openai-codex" })).toMatchObject({
				accountId: "acct_server",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(websocket()),
			Effect.timeout("10 seconds"),
			Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
			Effect.runPromise,
		);
	});

	it("reads server-side OAuth status through the CLI", () =>
		Effect.gen(function* () {
			const server = yield* HttpServer.HttpServer;
			if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const port = server.address.port;
			const result = yield* Effect.promise(() =>
				execCli(["auth", "status", "--openai-codex", "--server", `ws://127.0.0.1:${port}/rpc/v1`], process.cwd()),
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("no OpenAI Codex credentials found at the server");
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("20 seconds"), Effect.runPromise));

	it("runs session link and unlink through the CLI", () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "codework-cli-link-")));
		homes.push(project);
		return Effect.gen(function* () {
			const server = yield* HttpServer.HttpServer;
			if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const url = `ws://127.0.0.1:${server.address.port}/rpc/v1`;
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({});

			const linked = yield* Effect.promise(() =>
				execCli(["session", "link", session.session.id, project, "--server", url], project),
			);
			expect(linked.status).toBe(0);
			expect(linked.stdout).toContain(`Linked ${session.session.id} to ${project}`);
			expect((yield* rpc["thread.info"]({ sessionId: session.session.id })).session.hostDir).toBe(project);

			const unlinked = yield* Effect.promise(() =>
				execCli(["session", "link", session.session.id, "--unlink", "--server", url], project),
			);
			expect(unlinked.status).toBe(0);
			expect(unlinked.stdout).toContain(`Unlinked ${session.session.id}`);
			expect((yield* rpc["thread.info"]({ sessionId: session.session.id })).session.hostDir).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("20 seconds"), Effect.runPromise);
	});

	it("reports plugin reload success and failure through the CLI", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-cli-reload-")));
		homes.push(root);
		const module = join(root, "plugin.mjs");
		writeFileSync(module, 'export default { id: "acme.tool.reload", kind: "tool", setup() {} };\n');

		return Effect.gen(function* () {
			const server = yield* HttpServer.HttpServer;
			if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const url = `ws://127.0.0.1:${server.address.port}/rpc/v1`;

			const succeeded = yield* Effect.promise(() => execCli(["plugin", "reload", "--server", url], root));
			expect(succeeded.status).toBe(0);
			expect(succeeded.stdout).toMatch(/^Reloaded \d+ plugins?\.\n$/);

			yield* Effect.sync(() => writeFileSync(module, "export default { nope: true };\n"));
			const failed = yield* Effect.promise(() => execCli(["plugin", "reload", "--server", url], root));
			expect(failed.status).toBe(1);
			expect(failed.stdout).toContain("Reload failed, keeping");
			expect(failed.stdout).toContain("Missing key");
		}).pipe(
			Effect.scoped,
			Effect.provide(websocket({ plugins: [module] })),
			Effect.timeout("20 seconds"),
			Effect.runPromise,
		);
	});

	it("subscribes before a fast prompt and renders through completion, including continuation", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-6-luna" } } });
			const text: string[] = [];
			const render = (event: EventSchema.Payload) =>
				Effect.sync(() => {
					if (Schema.is(EventList.LLMTextDelta)(event)) text.push(event.data.delta);
				});
			const ref = { sessionId: session.session.id, threadId: session.id };
			yield* Client.run(rpc, { ...ref, text: "hello" }, render);
			yield* Client.run(rpc, { ...ref, text: "again" }, render);
			expect(text).toEqual(["response 1", "response 2"]);
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("thread.message finds a prompt that ran, scoped to its own thread", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-6-luna" } } });
			const messageId = Session.SessionMessageSchema.ID.create();

			yield* rpc["thread.prompt"]({ sessionId: session.session.id, text: "hello", id: messageId });
			yield* rpc["thread.wait"]({ sessionId: session.session.id });

			// This is the reconcile a client falls back on when the stream let it down.
			expect((yield* rpc["thread.message"]({ sessionId: session.session.id, messageId })).found).toBe(true);

			// Entry ids are global; the answer is not. Another session never sees it.
			const other = yield* rpc["session.create"]({});
			expect((yield* rpc["thread.message"]({ sessionId: other.session.id, messageId })).found).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("forks a thread, runs both, and deletes the session with every thread", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const main = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-6-luna" } } });
			const sessionId = main.session.id;
			const text = (event: EventSchema.Payload) =>
				Schema.is(EventList.LLMTextDelta)(event) ? [event.data.delta] : [];
			const replies: string[] = [];
			const render = (event: EventSchema.Payload) => Effect.sync(() => replies.push(...text(event)));

			yield* Client.run(rpc, { sessionId, threadId: main.id, text: "hello" }, render);
			const assistant = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1);
			if (assistant === undefined) return yield* Effect.die("main thread has no exchange");

			const at = yield* rpc["thread.fork"]({ sessionId, entryId: assistant.id });
			yield* Client.run(rpc, { sessionId, threadId: at.thread.id, text: "branch" }, render);
			const branched = (yield* rpc["thread.history"]({ sessionId, threadId: at.thread.id })).entries.at(-2);
			if (branched === undefined) return yield* Effect.die("fork has no exchange");
			// Editing the fork's own prompt again: a fork of a fork, through the inherited line.
			const before = yield* rpc["thread.fork"]({
				sessionId,
				threadId: at.thread.id,
				entryId: branched.id,
				mode: "before",
			});

			const labels = new Map<string, string>([
				[sessionId, "<session>"],
				[main.id, "<main>"],
				[at.thread.id, "<at>"],
				[before.thread.id, "<before>"],
				[assistant.id, "<main reply>"],
				[branched.id, "<branch prompt>"],
			]);
			const label = (id: string) => labels.get(id) ?? id;
			const origin = (info: typeof main) =>
				info.origin.kind === "fork"
					? { kind: info.origin.kind, threadId: label(info.origin.threadId), entryId: label(info.origin.entryId) }
					: info.origin;
			const history = (threadId: Session.ThreadSchema.ID) =>
				rpc["thread.history"]({ sessionId, threadId }).pipe(
					Effect.map(({ entries }) =>
						entries.map((entry) => ({
							thread: label(entry.threadId),
							role: entry.role,
							state: entry.state,
							text: entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
						})),
					),
				);
			const listed = yield* rpc["thread.list"]({ sessionId });
			const histories = {
				main: yield* history(main.id),
				at: yield* history(at.thread.id),
				before: yield* history(before.thread.id),
			};

			const deleted = yield* rpc["session.delete"]({ sessionId });
			const afterDelete = {
				threads: (yield* rpc["thread.list"]({ sessionId })).length,
				info: (yield* rpc["thread.info"]({ sessionId }).pipe(Effect.flip))._tag,
				again: yield* rpc["session.delete"]({ sessionId }),
			};

			const artifact = {
				replies,
				fork: {
					at: { origin: origin(at.thread), text: at.text, session: label(at.thread.session.id) },
					before: { origin: origin(before.thread), text: before.text },
				},
				listed: listed
					.map(({ id, origin, title }) => ({ id: label(id), kind: origin.kind, title }))
					.sort((a, b) => a.id.localeCompare(b.id)),
				histories,
				deleted,
				afterDelete,
			};
			expect(replies).toEqual(["response 1", "response 2"]);
			expect(at.thread.origin).toEqual({ kind: "fork", threadId: main.id, entryId: assistant.id });
			expect(before.text).toBe("branch");
			expect(histories.at.map(({ thread }) => thread)).toEqual(["<main>", "<main>", "<at>", "<at>"]);
			expect(histories.main).toHaveLength(2);
			expect(histories.before).toEqual(histories.main);
			expect(deleted).toEqual({ deleted: true });
			expect(afterDelete).toEqual({ threads: 0, info: "SessionNotFoundError", again: { deleted: false } });
			return artifact;
		})
			.pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise)
			.then((artifact) =>
				expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/server.fork.json"),
			));

	it("does not adopt a failure that belongs to another client's prompt", () =>
		Effect.gen(function* () {
			const firstEntered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const open = immediateOpen();
			let calls = 0;
			yield* Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const session = yield* rpc["session.create"]({
					runtime: { model: { provider: "openai", id: "gpt-6-luna" } },
				});
				// Watch admissions over the wire. The connected frame is the readiness
				// barrier: past it, nothing published can be missed.
				const queue = yield* rpc["event.subscribe"]({}).pipe(Stream.toQueue({ capacity: 64 }));
				expect((yield* Queue.take(queue)).type).toBe(Envelope.Connected.type);

				// Someone else's prompt owns the drain, and it is going to fail.
				yield* rpc["thread.prompt"]({
					sessionId: session.session.id,
					text: "theirs",
					id: Session.SessionMessageSchema.ID.create(),
				});
				yield* Deferred.await(firstEntered);

				// Ours is admitted while that drain is still running, so the failure
				// lands after our admission but before our promotion.
				const ours = yield* Client.run(
					rpc,
					{ sessionId: session.session.id, threadId: session.id, text: "ours" },
					() => Effect.void,
				).pipe(Effect.forkChild);
				let admissions = 0;
				while (admissions < 2) {
					if ((yield* Queue.take(queue)).type === EventList.PromptAdmitted.type) admissions += 1;
				}
				yield* Deferred.succeed(release, undefined);

				// The successor drain promotes ours; the remembered failure is dropped.
				yield* Fiber.join(ours);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					websocket({
						llm: (input, signal) =>
							Effect.suspend(() => {
								calls += 1;
								return calls === 1
									? Deferred.succeed(firstEntered, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
											Effect.andThen(Effect.die("their prompt failed")),
										)
									: open(input, signal);
							}),
					}),
				),
			);
		}).pipe(Effect.timeout("10 seconds"), Effect.runPromise));

	it("reports failures before prompt promotion without hanging", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({
				runtime: { model: { provider: "missing-test-provider", id: "missing-model" } },
			});
			const error = yield* Client.run(
				rpc,
				{ sessionId: session.session.id, threadId: session.id, text: "hello" },
				() => Effect.void,
			).pipe(Effect.flip);
			expect(error._tag).toBe("Client.ExecutionError");
			expect(error.message).toContain("missing-test-provider");
			// The category survives the wire, so a client can branch on it.
			if (error._tag === "Client.ExecutionError") expect(error.type).toBe("model-not-found-error");
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("runs the CLI against the server without booting a local harness", () =>
		Effect.gen(function* () {
			const server = yield* HttpServer.HttpServer;
			if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const port = server.address.port;
			const rpc = yield* connectedClient;
			const sandbox = yield* rpc["sandbox.create"]({ driver: "memory" });
			const result = yield* Effect.promise(() =>
				exec(
					process.execPath,
					[
						"--conditions=development",
						fileURLToPath(new URL("../src/index.ts", import.meta.url)),
						"run",
						"--server",
						`ws://127.0.0.1:${port}/rpc/v1`,
						"--sandbox-id",
						sandbox.id,
						"--provider",
						"openai",
						"--model",
						"gpt-6-luna",
						"hello",
					],
					{ timeout: 10000 },
				).catch((error: { stdout: string; stderr: string }) => {
					throw new Error(error.stdout + error.stderr);
				}),
			);
			expect(result.stdout).toBe("response 1\n");
			expect(result.stderr).toContain("ses_");
			expect(result.stderr).toContain(`sandbox-id: ${sandbox.id}`);
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.runPromise));

	it("dropping a client run does not cancel server execution", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const open = immediateOpen();
			let completed = false;
			const program = Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const session = yield* rpc["session.create"]({
					runtime: { model: { provider: "openai", id: "gpt-6-luna" } },
				});
				const running = yield* Client.run(
					rpc,
					{ sessionId: session.session.id, threadId: session.id, text: "hello" },
					() => Effect.void,
				).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(running);
				yield* Deferred.succeed(release, undefined);
				yield* rpc["thread.wait"]({ sessionId: session.session.id });
				expect(completed).toBe(true);
			});
			yield* program.pipe(
				Effect.scoped,
				Effect.provide(
					websocket({
						llm: (input, signal) =>
							Effect.gen(function* () {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
								completed = true;
								return yield* open(input, signal);
							}),
					}),
				),
			);
		}).pipe(Effect.timeout("4 seconds"), Effect.runPromise));

	it("explicit interruption stops a blocked run and is reported to subscribers", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const program = Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const session = yield* rpc["session.create"]({
					runtime: { model: { provider: "openai", id: "gpt-6-luna" } },
				});
				const running = yield* Client.run(
					rpc,
					{ sessionId: session.session.id, threadId: session.id, text: "hello" },
					() => Effect.void,
				).pipe(Effect.flip, Effect.forkChild);
				yield* Deferred.await(entered);
				expect((yield* rpc["session.interrupt"]({ sessionId: session.session.id })).interrupted).toBe(true);
				const error = yield* Fiber.join(running);
				expect(error._tag).toBe("Client.ExecutionError");
				// Not Effect's internal "All fibers interrupted without error".
				expect(error.message).toBe("Session interrupted");
				// A user-requested stop, not the shutdown path.
				if (error._tag === "Client.ExecutionError") expect(error.type).toBe("aborted");
				yield* rpc["thread.wait"]({ sessionId: session.session.id });
				expect((yield* rpc["session.interrupt"]({ sessionId: session.session.id })).interrupted).toBe(false);
			});
			yield* program.pipe(
				Effect.scoped,
				Effect.provide(
					websocket({ llm: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }),
				),
			);
		}).pipe(Effect.timeout("4 seconds"), Effect.runPromise));

	it("acknowledges interruption before blocked cleanup finishes", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let cleaned = false;
			const program = Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const session = yield* rpc["session.create"]({
					runtime: { model: { provider: "openai", id: "gpt-6-luna" } },
				});
				yield* rpc["thread.prompt"]({ sessionId: session.session.id, text: "hello" });
				yield* Deferred.await(entered);
				expect(
					(yield* rpc["session.interrupt"]({ sessionId: session.session.id }).pipe(Effect.timeout("1 second")))
						.interrupted,
				).toBe(true);
				expect(cleaned).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* rpc["thread.wait"]({ sessionId: session.session.id });
				expect(cleaned).toBe(true);
			});
			yield* program.pipe(
				Effect.ensuring(Deferred.succeed(release, undefined)),
				Effect.scoped,
				Effect.provide(
					websocket({
						llm: () =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.onInterrupt(() =>
									Deferred.await(release).pipe(
										Effect.tap(() =>
											Effect.sync(() => {
												cleaned = true;
											}),
										),
									),
								),
							),
					}),
				),
			);
		}).pipe(Effect.timeout("4 seconds"), Effect.runPromise));

	it("stops its managed sandboxes when the server shuts down", () =>
		Effect.gen(function* () {
			const home = mkdtempSync(join(tmpdir(), "codework-shutdown-"));
			homes.push(home);
			const harness = { home, hostCwd: home, database: join(home, "codework.db"), plugins: [] };
			const server = () => Server.layer({ host: "127.0.0.1", port: 0, harness });

			const id = yield* Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const sandbox = yield* rpc["sandbox.create"]({ driver: "memory" });
				expect(sandbox.status).toBe("online");
				return sandbox.id;
			}).pipe(Effect.scoped, Effect.provide(server()));

			// A second process over the same database sees what the first left behind:
			// the instance it provisioned was stopped on the way out.
			yield* Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const listed = yield* rpc["sandbox.list"]({});
				expect(listed.find((instance) => instance.id === id)?.status).toBe("offline");
			}).pipe(Effect.scoped, Effect.provide(server()));
		}).pipe(Effect.timeout("20 seconds"), Effect.runPromise));
});
