/* @effect-diagnostics nodeBuiltinImport:off -- the suite reads service.json and runs the CLI in temporary homes. */
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { HttpServer } from "effect/http";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import * as MachineFile from "../src/machine/file.ts";
import * as Client from "../src/server/client.ts";
import * as Registration from "../src/server/registration.ts";
import * as Server from "../src/server/server.ts";
import { models, runCli } from "./fixtures/cli.ts";
import { connect, registered } from "./utils/client.ts";
import { matrix } from "./utils/knock.ts";

const home = (name: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `codework-door-${name}-`)));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

/** A loopback port nothing listens on. */
const closedPort = () =>
	new Promise<number>((resolve) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
		});
	});

const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A server of `home` on loopback, for as long as the effect given to it runs. */
const serve = (dir: string) =>
	Server.layer({
		host: "127.0.0.1",
		port: 0,
		harness: { home: dir, hostCwd: dir, database: ":memory:", plugins: [], llm: immediateOpen() },
	});

it("the loopback server opens its socket only to a caller with its home's token", async () => {
	const local = home("local");
	// A token file an earlier build kept, which a start deletes.
	writeFileSync(join(local, "token"), "leftover");
	const other = home("other");
	const env = { ...process.env, HOME: other, CODEWORK_MODELS_FILE: models };
	const cli = (...args: Array<string>) =>
		runCli(["--home", other, "--user-config-dir", other, ...args], { cwd: other, env });
	onTestFinished(async () => void (await cli("service", "stop")));

	const result = await Effect.gen(function* () {
		const listener = yield* HttpServer.HttpServer;
		if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
		const port = listener.address.port;
		const url = `ws://127.0.0.1:${port}/rpc/v1`;

		// The registration: private to this user, naming the very URL a client is pointed at, with the
		// home's token.
		const file = join(local, "service.json");
		const filed = yield* registered(local);
		expect(filed.url).toBe(url);
		const token = filed.token;
		const serviceJson = {
			mode: mode(file),
			keys: Object.keys(filed).sort(),
			url: filed.url.replace(String(port), "<port>"),
		};

		const upgrade = yield* Effect.promise(() =>
			matrix(port, "/rpc/v1", token, { "right token, the desktop app's Origin": "codework://app" }),
		);

		// A client with another token never gets a call through, a mutation included.
		const refused = yield* Effect.gen(function* () {
			const context = yield* Layer.build(Client.layer({ url, token: "x".repeat(token.length) }));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));
			return yield* rpc["session.create"]({}).pipe(Effect.timeout("3 seconds"), Effect.isFailure);
		}).pipe(Effect.scoped);

		const rpc = yield* connect(local);
		const index = yield* rpc["index.sync"]({ after: 0 }).pipe(
			Stream.takeUntil((item) => item._tag === "Synced"),
			Stream.runCollect,
		);
		const before = yield* rpc["server.info"]({});
		// The server made a machine at startup; `codework connect --machine-id` replaces its generated id
		// while the server runs, and the next call names it.
		yield* MachineFile.update(local, { machineId: "door-machine" }, Effect.succeed).pipe(
			Effect.provide(NodeServices.layer),
		);
		const after = yield* rpc["server.info"]({});

		// The real CLI: a background server of another home, found through that home's service.json.
		const started = yield* Effect.promise(() => cli("service", "start", "--port", "0"));
		expect(started.status, started.stderr).toBe(0);
		const otherServer = yield* registered(other);
		const otherRpc = yield* connect(other);
		const session = yield* otherRpc["session.create"]({});
		const alias = otherServer.url.replace("127.0.0.1", "localhost");
		const gone = `ws://127.0.0.1:${yield* Effect.promise(closedPort)}/rpc/v1`;
		const scrub = (text: string) =>
			text
				.replaceAll(otherServer.url, "<other server>")
				.replaceAll(alias, "<other server as localhost>")
				.replaceAll(gone, "<closed port>")
				.replaceAll(url, "<local server>")
				.replaceAll(session.session.id, "<session>")
				.replaceAll(session.id, "<main>");
		const scrubbed = (done: { status: number | null; stdout: string; stderr: string }) => ({
			status: done.status,
			stdout: scrub(done.stdout),
			stderr: scrub(done.stderr),
		});
		const run = (...args: Array<string>) => Effect.promise(() => cli(...args)).pipe(Effect.map(scrubbed));
		/** The CLI in a home whose service.json names `url`, with a token no server holds. */
		const stale = (url: string, ...args: Array<string>) => {
			const dir = home("filed");
			const info = {
				pid: process.pid,
				version: "0.0.0",
				url,
				port: Number(new URL(url).port),
				token: "x".repeat(token.length),
			};
			writeFileSync(Registration.file(dir), JSON.stringify(info), { mode: 0o600 });
			return Effect.promise(() => runCli(["--home", dir, ...args], { cwd: dir, env })).pipe(Effect.map(scrubbed));
		};
		const status = yield* run("service", "status");
		const threads = yield* run("thread", "list", session.session.id, "--server", otherServer.url);
		// A loopback alias of the home's own server reaches it, with the token.
		const aliased = yield* run("thread", "list", session.session.id, "--server", alias);
		// Its home names another URL, so it holds no token for this one.
		const elsewhere = yield* run("thread", "list", session.session.id, "--server", url);
		expect(elsewhere.status).toBe(1);
		// --home picks the token, so it comes along with --server: the server answers for its own logins.
		const auth = yield* run("auth", "status", "--openai-codex", "--server", otherServer.url);
		const wrongToken = yield* stale(url, "thread", "list", session.session.id, "--server", url);
		const unreachable = yield* stale(gone, "thread", "list", session.session.id, "--server", gone);

		// A session id the schema refuses, and a flag check of run: each one `error:` line.
		const notSession = yield* run("thread", "list", "foo", "--server", otherServer.url);
		const runNotSession = yield* run("run", "--session", "foo", "hi", "--server", otherServer.url);
		// cli() passes --user-config-dir, which run refuses next to --server.
		const runFlags = yield* run("run", "hi", "--server", otherServer.url);

		const stopped = yield* run("service", "stop");
		const afterStop = yield* run("service", "status");
		const noServer = yield* run("thread", "list", session.session.id, "--server", otherServer.url);

		return {
			token,
			result: {
				serviceJson,
				"token file": existsSync(join(local, "token")),
				upgrade,
				"a call with another token goes through": !refused,
				"sessions made by the refused call": index.filter((item) => item._tag === "Session").length,
				machineId: {
					before:
						before.machineId === undefined
							? null
							: uuid.test(before.machineId)
								? "<generated>"
								: before.machineId,
					after: after.machineId ?? null,
				},
				cli: {
					start: scrub(started.stdout),
					status,
					threads,
					"the home's server as localhost": aliased,
					"another home's server": elsewhere,
					"auth status with --home and --server": auth,
					"a filed server that refuses the token": wrongToken,
					"a filed server that is gone": unreachable,
					"not a session id": notSession,
					"run with not a session id": runNotSession,
					"run with --user-config-dir and --server": runFlags,
					stop: stopped,
					"status after stop": afterStop,
					"no server for the home": noServer,
				},
			},
		};
	}).pipe(Effect.scoped, Effect.provide(serve(local)), Effect.timeout("60 seconds"), Effect.runPromise);

	// The token is the server's: a restart in the same home files a new one.
	const restarted = await registered(local).pipe(
		Effect.provide(serve(local)),
		Effect.scoped,
		Effect.timeout("30 seconds"),
		Effect.runPromise,
	);
	const artifact = {
		...result.result,
		"a new token after a restart": restarted.token !== result.token,
	};
	const text = `${JSON.stringify(artifact, null, "\t")}\n`;
	expect(text).not.toContain(result.token);
	await expect(text).toMatchFileSnapshot("./__artifacts__/door.json");
}, 120_000);
