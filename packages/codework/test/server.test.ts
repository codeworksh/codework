/* @effect-diagnostics nodeBuiltinImport:off -- fixtures only need temp dirs. */
import { Event, EventList, EventSchema, Harness, Sandbox, Session } from "@codeworksh/harness/effect";
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { define as definePlugin } from "../../harness/src/plugin/plugin.ts";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { Client } from "../src/server/client.ts";
import { Contract } from "../src/server/contract.ts";
import { Envelope } from "../src/server/envelope.ts";
import { EventFeed } from "../src/server/feed.ts";
import { Handlers } from "../src/server/handlers.ts";
import { Server } from "../src/server/server.ts";
import { linkedDirectory } from "../src/cli/cmd/handlers/plugin/session.ts";

process.env.CODEWORK_MODELS_FILE ??= fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const homes: string[] = [];
const layer = (options: Harness.Options = {}) => {
	const home = mkdtempSync(join(tmpdir(), "codework-server-"));
	homes.push(home);
	return Handlers.layer.pipe(
		Layer.provide(EventFeed.layer),
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

	it("session.create + session.info + session.list round-trip", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			expect(created.id.startsWith("ses")).toBe(true);

			const info = yield* rpc["session.info"]({ sessionId: created.id });
			expect(info.id).toBe(created.id);

			const listed = yield* rpc["session.list"]({});
			expect(listed.some(({ id }) => id === created.id)).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("session.create honours a client-supplied hostDir, and omits it when the client named none", () => {
		const root = mkdtempSync(join(tmpdir(), "codework-server-hostdir-"));
		homes.push(root);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			// Passed through as given. The client is the owner of this machine, so naming a host
			// path is no more privilege than running `codework` in it.
			const placed = yield* rpc["session.create"]({ hostDir: root });
			expect(placed.hostDir).toBe(root);
			expect((yield* rpc["session.info"]({ sessionId: placed.id })).hostDir).toBe(root);

			// And nothing fills it in: a session the client did not place has no host project,
			// rather than quietly adopting the server's own startup directory.
			const unplaced = yield* rpc["session.create"]({});
			expect(unplaced.hostDir).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise);
	});

	it("session.link sets and clears a session's host directory", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-server-link-")));
		homes.push(root);

		return Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const created = yield* rpc["session.create"]({});
			expect(created.hostDir).toBeUndefined();

			const linked = yield* rpc["session.link"]({ sessionId: created.id, hostDir: root });
			expect(linked.hostDir).toBe(root);
			// Stored, not held in the call: a later reader sees it too.
			expect((yield* rpc["session.info"]({ sessionId: created.id })).hostDir).toBe(root);

			// Omitting the field unlinks, returning the session to the user layer alone.
			const cleared = yield* rpc["session.link"]({ sessionId: created.id });
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
			const failure = yield* linkedDirectory(created.id, Option.some(home)).pipe(Effect.flip);
			expect(failure).toMatchObject({ _tag: "SessionNotLinkedError", reason: "session-not-linked" });

			// Linked, the same lookup answers with the directory.
			yield* rpc["session.link"]({ sessionId: created.id, hostDir: realpathSync(home) });
			expect(yield* linkedDirectory(created.id, Option.some(home))).toBe(realpathSync(home));
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
				yield* rpc["session.link"]({ sessionId: created.id, hostDir: "my-project" });
			}).pipe(Effect.scoped, Effect.provide(layer({ home, hostCwd: home })), Effect.runPromise),
		).rejects.toThrow(/absolute path/);
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
			yield* rpc["session.link"]({ sessionId: created.id, hostDir: project });

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
					["--conditions=development", cli, "plugin", "add", "./tool", "--session", created.id, "--home", home],
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

	it("session.info fails with SessionNotFoundError for a bogus id", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const failure = yield* rpc["session.info"]({
				sessionId: Session.SessionSchema.ID.ascending("ses_nope"),
			}).pipe(Effect.flip);
			expect(failure._tag).toBe("SessionNotFoundError");
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
				sessionId: session.id,
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
			yield* rpc["session.prompt"]({ sessionId: session.id, text: "hello" });

			const envelope = yield* Fiber.join(admitted).pipe(Effect.timeout("10 seconds"));
			expect(Option.isSome(envelope)).toBe(true);
			const decoded = yield* Envelope.decode(Option.getOrThrow(envelope));
			expect(decoded.type).toBe(EventList.PromptAdmitted.type);
			expect((decoded.data as { readonly sessionId?: string }).sessionId).toBe(session.id);
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
			expect(first.sandbox?.id).toBe(sandbox.id);
			expect(second.sandbox?.id).toBe(sandbox.id);
			const relinked = yield* rpc["session.relink"]({ sessionId: first.id, sandbox: { id: sandbox.id } });
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

	it("session.message reports an unknown prompt as absent", () =>
		Effect.gen(function* () {
			const rpc = yield* RpcTest.makeClient(Contract.Api);
			const session = yield* rpc["session.create"]({});
			const found = yield* rpc["session.message"]({
				sessionId: session.id,
				messageId: Session.SessionMessageSchema.ID.create(),
			});
			expect(found.found).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise));

	it("reports malformed public payloads as typed encoding errors", () =>
		Effect.gen(function* () {
			const error = yield* Envelope.encode({
				id: EventSchema.ID.create(),
				type: EventList.ExecutionSucceeded.type,
				data: {},
			}).pipe(Effect.flip);
			expect(error._tag).toBe("EventEncodingError");
		}).pipe(Effect.runPromise));

	it("unknown event types produce typed encode/decode errors", () =>
		Effect.gen(function* () {
			const encodeError = yield* Envelope.encode({
				id: EventSchema.ID.create(),
				type: "nope",
				data: {},
			}).pipe(Effect.flip);
			expect(encodeError._tag).toBe("UnknownEventTypeError");

			const failure = yield* Envelope.decode({
				id: EventSchema.ID.create(),
				type: "nope",
				data: {},
			}).pipe(Effect.flip);
			expect(failure._tag).toBe("UnknownEventTypeError");
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
	const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${server.address.port}/rpc`));
	return yield* Client.make.pipe(Effect.provideContext(context));
});

describe("WebSocket client", () => {
	it("subscribes before a fast prompt and renders through completion, including continuation", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-5.5" } } });
			const text: string[] = [];
			const render = (event: EventSchema.Payload) =>
				Effect.sync(() => {
					if (Schema.is(EventList.LLMTextDelta)(event)) text.push(event.data.delta);
				});
			yield* Client.run(rpc, { sessionId: session.id, text: "hello" }, render);
			yield* Client.run(rpc, { sessionId: session.id, text: "again" }, render);
			expect(text).toEqual(["response 1", "response 2"]);
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("session.message finds a prompt that ran, scoped to its own session", () =>
		Effect.gen(function* () {
			const rpc = yield* connectedClient;
			const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-5.5" } } });
			const messageId = Session.SessionMessageSchema.ID.create();

			yield* rpc["session.prompt"]({ sessionId: session.id, text: "hello", id: messageId });
			yield* rpc["session.wait"]({ sessionId: session.id });

			// This is the reconcile a client falls back on when the stream let it down.
			expect((yield* rpc["session.message"]({ sessionId: session.id, messageId })).found).toBe(true);

			// Entry ids are global; the answer is not. Another session never sees it.
			const other = yield* rpc["session.create"]({});
			expect((yield* rpc["session.message"]({ sessionId: other.id, messageId })).found).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(websocket()), Effect.timeout("10 seconds"), Effect.runPromise));

	it("does not adopt a failure that belongs to another client's prompt", () =>
		Effect.gen(function* () {
			const firstEntered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const open = immediateOpen();
			let calls = 0;
			yield* Effect.gen(function* () {
				const rpc = yield* connectedClient;
				const session = yield* rpc["session.create"]({
					runtime: { model: { provider: "openai", id: "gpt-5.5" } },
				});
				// Watch admissions over the wire. The connected frame is the readiness
				// barrier: past it, nothing published can be missed.
				const queue = yield* rpc["event.subscribe"]({}).pipe(Stream.toQueue({ capacity: 64 }));
				expect((yield* Queue.take(queue)).type).toBe(Envelope.Connected.type);

				// Someone else's prompt owns the drain, and it is going to fail.
				yield* rpc["session.prompt"]({
					sessionId: session.id,
					text: "theirs",
					id: Session.SessionMessageSchema.ID.create(),
				});
				yield* Deferred.await(firstEntered);

				// Ours is admitted while that drain is still running, so the failure
				// lands after our admission but before our promotion.
				const ours = yield* Client.run(rpc, { sessionId: session.id, text: "ours" }, () => Effect.void).pipe(
					Effect.forkChild,
				);
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
			const error = yield* Client.run(rpc, { sessionId: session.id, text: "hello" }, () => Effect.void).pipe(
				Effect.flip,
			);
			expect(error._tag).toBe("Client.ExecutionError");
			expect(error.message).toContain("missing-test-provider");
			// The category survives the wire, so a client can branch on it.
			if (error._tag === "Client.ExecutionError") expect(error.type).toBe("model.not-found");
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
						`ws://127.0.0.1:${port}/rpc`,
						"--sandbox-id",
						sandbox.id,
						"--provider",
						"openai",
						"--model",
						"gpt-5.5",
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
				const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-5.5" } } });
				const running = yield* Client.run(rpc, { sessionId: session.id, text: "hello" }, () => Effect.void).pipe(
					Effect.forkChild,
				);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(running);
				yield* Deferred.succeed(release, undefined);
				yield* rpc["session.wait"]({ sessionId: session.id });
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
				const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-5.5" } } });
				const running = yield* Client.run(rpc, { sessionId: session.id, text: "hello" }, () => Effect.void).pipe(
					Effect.flip,
					Effect.forkChild,
				);
				yield* Deferred.await(entered);
				expect((yield* rpc["session.interrupt"]({ sessionId: session.id })).interrupted).toBe(true);
				const error = yield* Fiber.join(running);
				expect(error._tag).toBe("Client.ExecutionError");
				// Not Effect's internal "All fibers interrupted without error".
				expect(error.message).toBe("Session interrupted");
				// A user-requested stop, not the shutdown path.
				if (error._tag === "Client.ExecutionError") expect(error.type).toBe("aborted");
				yield* rpc["session.wait"]({ sessionId: session.id });
				expect((yield* rpc["session.interrupt"]({ sessionId: session.id })).interrupted).toBe(false);
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
				const session = yield* rpc["session.create"]({ runtime: { model: { provider: "openai", id: "gpt-5.5" } } });
				yield* rpc["session.prompt"]({ sessionId: session.id, text: "hello" });
				yield* Deferred.await(entered);
				expect(
					(yield* rpc["session.interrupt"]({ sessionId: session.id }).pipe(Effect.timeout("1 second")))
						.interrupted,
				).toBe(true);
				expect(cleaned).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* rpc["session.wait"]({ sessionId: session.id });
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

	it("round-trips encoded timestamps through JSON", () =>
		Effect.gen(function* () {
			const timestamp = yield* DateTime.now;
			const encoded = yield* Envelope.encode({
				id: EventSchema.ID.create(),
				type: EventList.ExecutionSucceeded.type,
				data: { timestamp, sessionId: Session.SessionSchema.ID.create() },
			});
			const codec = Schema.fromJsonString(Envelope.EventEnvelope);
			const json = yield* Schema.encodeEffect(codec)(encoded);
			const decoded = yield* Envelope.decode(yield* Schema.decodeEffect(codec)(json));
			expect(Schema.is(EventList.ExecutionSucceeded)(decoded)).toBe(true);
			if (Schema.is(EventList.ExecutionSucceeded)(decoded))
				expect(DateTime.toEpochMillis(decoded.data.timestamp)).toBe(DateTime.toEpochMillis(timestamp));
		}).pipe(Effect.runPromise));
});
