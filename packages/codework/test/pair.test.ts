/* @effect-diagnostics nodeBuiltinImport:off -- the suite reads the home's files and runs the CLI in temporary homes. */
/* @effect-diagnostics globalFetch:off -- the pairing routes are plain HTTP, as another computer calls them. */
/* @effect-diagnostics globalFetchInEffect:off -- the pairing routes are plain HTTP, as another computer calls them. */
import { Pairing as Wire } from "@codeworksh/schema";
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Result, Schema, Stream } from "effect";
import { HttpServer } from "effect/http";
import { RpcClientError } from "effect/rpc";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import * as Client from "../src/server/client.ts";
import type { IndexItem } from "../src/server/contract.ts";
import * as Pairing from "../src/server/pairing.ts";
import * as Server from "../src/server/server.ts";
import { models, runCli, serveCli } from "./fixtures/cli.ts";
import { connect, registered } from "./utils/client.ts";
import { knock } from "./utils/knock.ts";
import { proxy } from "./utils/proxy.ts";

const home = (name: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `codework-pair-${name}-`)));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

/** A clock `by()` milliseconds ahead of `real`, so a lifetime runs out without waiting for it. Sleeps stay real. */
const ahead = (real: Clock.Clock, by: () => number): Clock.Clock => ({
	currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + by(),
	currentTimeMillis: Effect.sync(() => real.currentTimeMillisUnsafe() + by()),
	currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe() + BigInt(by()) * 1_000_000n,
	currentTimeNanos: Effect.sync(() => real.currentTimeNanosUnsafe() + BigInt(by()) * 1_000_000n),
	monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
	monotonicTimeNanos: real.monotonicTimeNanos,
	sleep: (duration) => real.sleep(duration),
});

/** A server of `dir` on `host`, reading the time from `clock`. */
const serve = (dir: string, clock: Clock.Clock, host = "127.0.0.1") =>
	Server.layer({
		host,
		port: 0,
		harness: { home: dir, hostCwd: dir, database: join(dir, "store.db"), plugins: [], llm: immediateOpen() },
	}).pipe(Layer.provide(Layer.succeed(Clock.Clock, clock)));

const port = Effect.gen(function* () {
	const address = (yield* HttpServer.HttpServer).address;
	if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
	return address.port;
});

/** `devices.json` as far as the suite reads it: a hash per device. */
const Stored = Schema.fromJsonString(Schema.Array(Schema.Struct({ hash: Schema.String })));

/** The pairing routes of the listener at `base`, as another computer calls them. */
const routes = (base: string) => {
	const post = (path: string, init: RequestInit) =>
		Effect.promise(() => fetch(`${base}${path}`, { method: "POST", ...init }));
	const json = (body: unknown, headers: Record<string, string> = {}) => ({
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return {
		/** The status `POST /api/v1/devices` answers. */
		pairStatus: (body: unknown, headers?: Record<string, string>) =>
			Effect.map(post(Wire.devicesPath, json(body, headers)), (response) => response.status),
		pair: (code: string, label: string, headers?: Record<string, string>) =>
			post(Wire.devicesPath, json({ code, label }, headers)).pipe(
				Effect.flatMap((response) => Effect.promise(() => response.json())),
				Effect.flatMap(Schema.decodeUnknownEffect(Wire.Device)),
				Effect.orDie,
			),
		ticketStatus: (authorization?: string) =>
			Effect.map(
				post(Wire.ticketsPath, authorization === undefined ? {} : { headers: { authorization } }),
				(response) => response.status,
			),
		ticket: (token: string, headers: Record<string, string> = {}) =>
			post(Wire.ticketsPath, { headers: { ...headers, authorization: `Bearer ${token}` } }).pipe(
				Effect.flatMap((response) => Effect.promise(() => response.json())),
				Effect.flatMap(Schema.decodeUnknownEffect(Wire.Ticket)),
				Effect.map(({ ticket }) => ticket),
				Effect.orDie,
			),
	};
};

/** The status an upgrade offering `credential` gets. */
const upgrade = (port: number, credential: string, host?: string, headers: Record<string, string> = {}) =>
	Effect.promise(() =>
		knock(port, "/rpc/v1", { ...headers, "Sec-WebSocket-Protocol": `codework, ${credential}` }, host),
	).pipe(Effect.map((answer) => answer.status));

/** A client of the listener at `url` on a socket opened with `ticket`. */
const device = (url: string, ticket: string) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(Client.layer({ url, token: ticket }));
		return yield* Client.make.pipe(Effect.provideContext(context));
	});

/** `index.sync` followed in the background, from its first `Synced` on: what came live, and how it ended. */
const follow = Effect.fn(function* (rpc: Client.Client) {
	const live: Array<IndexItem> = [];
	const synced = yield* Deferred.make<void>();
	const fiber = yield* rpc["index.sync"]({ after: 0 }).pipe(
		Stream.runForEach((item) =>
			item._tag === "Synced"
				? Deferred.succeed(synced, undefined)
				: Effect.sync(() => void (Deferred.isDoneUnsafe(synced) && live.push(item))),
		),
		Effect.forkScoped,
	);
	yield* Deferred.await(synced);
	return { fiber, live };
});

const isClientError = Schema.is(RpcClientError.RpcClientError);

/** How a device's call or stream ended, as the artifact keeps it. */
const ending = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.match(exit, {
		onSuccess: () => "completed",
		onFailure: (cause) =>
			Result.match(Cause.findError(cause), {
				onSuccess: (error) => (isClientError(error) ? `failed: ${error.reason._tag}` : "failed otherwise"),
				onFailure: () => "failed otherwise",
			}),
	});

it("a paired device takes a ticket per socket, calls as a device, and is cut off when revoked", async () => {
	const local = home("local");
	// A token file an earlier build kept, which a start deletes.
	writeFileSync(join(local, "token"), "leftover");
	const env = { ...process.env, HOME: local, CODEWORK_MODELS_FILE: models };
	const cli = (...args: Array<string>) =>
		Effect.promise(() => runCli(["--home", local, ...args], { cwd: local, env }));
	let offset = 0;
	const forward = (duration: Duration.Input) => Effect.sync(() => void (offset += Duration.toMillis(duration)));

	const secrets: Array<string> = [];
	const names = new Map<string, string>();
	const scrub = (text: string) =>
		[...names].reduce(
			(out, [value, name]) => out.replaceAll(value, name),
			text
				.replace(/\b[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}\b/g, "<code>")
				.replace(/\d{4}-\d\d-\d\dT[\d:]+Z/g, "<time>"),
		);
	const scrubbed = (done: { status: number | null; stdout: string; stderr: string }) => ({
		status: done.status,
		stdout: scrub(done.stdout),
		stderr: scrub(done.stderr),
	});
	/** A device paired through the CLI's code, named `name` in the artifact. */
	const pairDevice = Effect.fn(function* (base: string, name: string) {
		const code = (yield* cli("service", "pair")).stdout.trim();
		const paired = yield* routes(base).pair(code, name);
		secrets.push(paired.token);
		names.set(paired.id, `<${name}>`);
		return paired;
	});

	const first = await Effect.gen(function* () {
		const real = yield* Clock.Clock;
		return yield* Effect.gen(function* () {
			const listening = yield* port;
			const base = `http://127.0.0.1:${listening}`;
			const url = `ws://127.0.0.1:${listening}/rpc/v1`;
			const http = routes(base);
			const filed = yield* registered(local);
			secrets.push(filed.token);
			const rpc = yield* connect(local);

			// Codes: a person types one back in any case, with or without its dash; each works once.
			const printed = yield* cli("service", "pair");
			const code = printed.stdout.trim();
			const exchange = {
				"pair prints": scrubbed(printed),
				"a wrong code": yield* http.pairStatus({ code: "00000-00000", label: "Laptop" }),
				"no label": yield* http.pairStatus({ code }),
				"a foreign Origin": yield* http.pairStatus({ code, label: "Laptop" }, { origin: "https://evil.example" }),
			};
			const laptop = yield* http.pair(code.toLowerCase().replace("-", ""), "Laptop");
			secrets.push(laptop.token);
			names.set(laptop.id, "<Laptop>");
			const used = yield* http.pairStatus({ code, label: "Again" });
			const stale = (yield* cli("service", "pair")).stdout.trim();
			yield* forward("10 minutes");
			const expired = yield* http.pairStatus({ code: stale, label: "Late" });

			// Tickets: one per socket, used once, for 60 seconds.
			const tickets = {
				"no Authorization": yield* http.ticketStatus(),
				"an unknown session": yield* http.ticketStatus(`Bearer ${"x".repeat(43)}`),
				"the home's token as a session": yield* http.ticketStatus(`Bearer ${filed.token}`),
			};
			const ticket = yield* http.ticket(laptop.token);
			const laptopRpc = yield* device(url, ticket);
			const info = yield* laptopRpc["server.info"]({});
			const reused = yield* upgrade(listening, ticket);
			const late = yield* http.ticket(laptop.token);
			yield* forward("61 seconds");
			const lateUpgrade = yield* upgrade(listening, late);

			// A device calls what a local caller does, but never manages devices.
			const created = yield* laptopRpc["session.create"]({});
			const forbidden = yield* laptopRpc["device.list"]({}).pipe(
				Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "listed" }),
			);
			const pairForbidden = yield* laptopRpc["device.pair"]({}).pipe(
				Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "paired" }),
			);

			// A session unseen for 30 days is refused; one seen since is not.
			const idle = yield* pairDevice(base, "Idle");
			yield* forward("29 days");
			const desktop = yield* pairDevice(base, "Desktop");
			const tablet = yield* pairDevice(base, "Tablet");
			yield* http.ticket(laptop.token);
			yield* forward("1 day");
			yield* forward("1 second");
			const idleTicket = yield* http.ticketStatus(`Bearer ${idle.token}`);
			const devices = yield* cli("service", "devices");

			// Revoking a device ends its socket at once; another device's stays up.
			const desktopRpc = yield* device(url, yield* http.ticket(desktop.token));
			const tabletRpc = yield* device(url, yield* http.ticket(tablet.token));
			const desktopFeed = yield* follow(desktopRpc);
			const tabletFeed = yield* follow(tabletRpc);
			const queued = yield* http.ticket(desktop.token);
			const revoked = yield* cli("service", "revoke", desktop.id);
			const ended = yield* Fiber.await(desktopFeed.fiber).pipe(Effect.timeout("5 seconds"));
			const after = yield* rpc["session.create"]({});
			yield* Effect.gen(function* () {
				while (!tabletFeed.live.some((item) => item._tag === "Session" && item.session.id === after.session.id))
					yield* Effect.sleep("50 millis");
			}).pipe(Effect.timeout("5 seconds"));
			const revocation = {
				revoke: scrubbed(revoked),
				"the revoked device's stream": ending(ended),
				"the other device's stream sees a session made after":
					tabletFeed.fiber.pollUnsafe() === undefined ? "live" : "ended",
				"a ticket it took before": yield* upgrade(listening, queued),
				"a new ticket": yield* http.ticketStatus(`Bearer ${desktop.token}`),
				"revoke again": scrubbed(yield* cli("service", "revoke", desktop.id)),
				devices: scrubbed(yield* cli("service", "devices")),
			};

			// What a restart must forget.
			const pending = (yield* cli("service", "pair")).stdout.trim();
			const unspent = yield* http.ticket(tablet.token);

			const file = Pairing.file(local);
			const stored = readFileSync(file, "utf8");
			return {
				pending,
				unspent,
				tablet,
				created: created.session.id,
				artifact: {
					exchange: {
						...exchange,
						"its code, typed lower case without the dash": "paired",
						"the same code again": used,
						"a code past 10 minutes": expired,
					},
					tickets: {
						...tickets,
						"a device's call": { storeId: info.storeId === (yield* rpc["server.info"]({})).storeId },
						"the same ticket again": reused,
						"a ticket past 60 seconds": lateUpgrade,
					},
					device: {
						"session.create": created.session.id.startsWith("ses_"),
						"device.list": forbidden,
						"device.pair": pairForbidden,
					},
					idle: { "a session unseen for 30 days": idleTicket, devices: scrubbed(devices) },
					revocation,
					"devices.json": {
						mode: (statSync(file).mode & 0o777).toString(8),
						"raw tokens": secrets.filter((secret) => stored.includes(secret)).length,
						hashes: (yield* Schema.decodeEffect(Stored)(stored)).length,
					},
					"token file": existsSync(join(local, "token")),
				},
			};
		}).pipe(
			Effect.provide(
				serve(
					local,
					ahead(real, () => offset),
				),
			),
		);
	}).pipe(Effect.scoped, Effect.timeout("90 seconds"), Effect.runPromise);

	// Devices persist across a restart; codes and tickets do not.
	const restarted = await Effect.gen(function* () {
		const real = yield* Clock.Clock;
		return yield* Effect.gen(function* () {
			const listening = yield* port;
			const http = routes(`http://127.0.0.1:${listening}`);
			const url = `ws://127.0.0.1:${listening}/rpc/v1`;
			const tabletRpc = yield* device(url, yield* http.ticket(first.tablet.token));
			const sessions = yield* tabletRpc["index.sync"]({ after: 0 }).pipe(
				Stream.takeUntil((item) => item._tag === "Synced"),
				Stream.filter((item) => item._tag === "Session"),
				Stream.runCount,
			);
			return {
				"the same session takes a ticket and calls": sessions > 0,
				"a code from before": yield* http.pairStatus({ code: first.pending, label: "Late" }),
				"a ticket from before": yield* upgrade(listening, first.unspent),
			};
		}).pipe(
			Effect.provide(
				serve(
					local,
					ahead(real, () => offset),
				),
			),
		);
	}).pipe(Effect.scoped, Effect.timeout("60 seconds"), Effect.runPromise);
	const noServer = await Effect.runPromise(cli("service", "pair"));

	const text = `${JSON.stringify({ ...first.artifact, restart: restarted, "pair with no server": scrubbed(noServer) }, null, "\t")}\n`;
	for (const secret of secrets) expect(text).not.toContain(secret);
	await expect(text).toMatchFileSnapshot("./__artifacts__/pair.json");
}, 180_000);

it("a device leaves its own pairing; another device stays, and a local caller has none to leave", async () => {
	const dir = home("leave");
	const result = await Effect.gen(function* () {
		const real = yield* Clock.Clock;
		return yield* Effect.gen(function* () {
			const listening = yield* port;
			const http = routes(`http://127.0.0.1:${listening}`);
			const url = `ws://127.0.0.1:${listening}/rpc/v1`;
			const filed = yield* registered(dir);
			const rpc = yield* connect(dir);
			const names = new Map<string, string>();
			const pairDevice = Effect.fn(function* (name: string) {
				const paired = yield* http.pair((yield* rpc["device.pair"]({})).code, name);
				names.set(paired.id, `<${name}>`);
				return paired;
			});
			const desktop = yield* pairDevice("Desktop");
			const tablet = yield* pairDevice("Tablet");
			const desktopRpc = yield* device(url, yield* http.ticket(desktop.token));
			const desktopFeed = yield* follow(yield* device(url, yield* http.ticket(desktop.token)));
			const tabletRpc = yield* device(url, yield* http.ticket(tablet.token));
			const tabletFeed = yield* follow(tabletRpc);
			const queued = yield* http.ticket(desktop.token);

			// The reply races its own socket's end, so either outcome means it left.
			const left = ending(yield* Effect.exit(desktopRpc["device.leave"]({})));
			// Refused or closed, by the same race.
			const own = ending(yield* Effect.exit(desktopRpc["server.info"]({})));
			const ended = yield* Fiber.await(desktopFeed.fiber).pipe(Effect.timeout("5 seconds"));
			const after = yield* rpc["session.create"]({});
			yield* Effect.gen(function* () {
				while (!tabletFeed.live.some((item) => item._tag === "Session" && item.session.id === after.session.id))
					yield* Effect.sleep("50 millis");
			}).pipe(Effect.timeout("5 seconds"));
			const devices = yield* rpc["device.list"]({});
			const artifact = {
				"device.leave": left === "completed" || left === "failed: SocketCloseError" ? "left" : left,
				"its other socket's stream": ending(ended),
				"a call on the socket it left on": own === "completed" ? "answered" : "ended",
				"a ticket it took before": yield* upgrade(listening, queued),
				"a new ticket": yield* http.ticketStatus(`Bearer ${desktop.token}`),
				"device.list": devices.map((each) => names.get(each.id) ?? "<unknown>"),
				"the other device's stream sees a session made after":
					tabletFeed.fiber.pollUnsafe() === undefined ? "live" : "ended",
				"the other device calls": (yield* tabletRpc["server.info"]({})).storeId.length > 0,
				"device.leave from this computer": yield* rpc["device.leave"]({}).pipe(
					Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "left" }),
				),
			};
			return { artifact, secrets: [filed.token, desktop.token, tablet.token, queued] };
		}).pipe(Effect.provide(serve(dir, real)));
	}).pipe(Effect.scoped, Effect.timeout("60 seconds"), Effect.runPromise);
	const text = `${JSON.stringify(result.artifact, null, "\t")}\n`;
	for (const secret of result.secrets) expect(text).not.toContain(secret);
	await expect(text).toMatchFileSnapshot("./__artifacts__/pair.leave.json");
}, 60_000);

/** An IPv4 address of this computer other than loopback, as another computer on its network reaches it. */
const lan = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === "IPv4" && !address.internal)?.address;

it.skipIf(lan === undefined)(
	"the home's token opens a socket from loopback only; a ticket from anywhere",
	async () => {
		const dir = home("remote");
		const result = await Effect.gen(function* () {
			const real = yield* Clock.Clock;
			return yield* Effect.gen(function* () {
				const listening = yield* port;
				const { token } = yield* registered(dir);
				const rpc = yield* connect(dir);
				const http = routes(`http://${lan}:${listening}`);
				const paired = yield* http.pair((yield* rpc["device.pair"]({})).code, "Remote");
				return {
					"the home's token from loopback": yield* upgrade(listening, token),
					"the home's token from another address": yield* upgrade(listening, token, lan),
					"a ticket from another address": yield* upgrade(listening, yield* http.ticket(paired.token), lan),
				};
			}).pipe(Effect.provide(serve(dir, real, "0.0.0.0")));
		}).pipe(Effect.scoped, Effect.timeout("60 seconds"), Effect.runPromise);
		await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/pair.remote.json");
	},
	60_000,
);

/** `codework service devices` of `dir`'s server, with each device id named and each time scrubbed. */
const devicesOf = (dir: string, names: ReadonlyMap<string, string>) =>
	Effect.promise(() =>
		runCli(["--home", dir, "service", "devices"], {
			cwd: dir,
			env: { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models },
		}),
	).pipe(
		Effect.map(({ status, stdout, stderr }) => ({
			status,
			stdout: [...names]
				.reduce((out, [id, name]) => out.replaceAll(id, name), stdout)
				.replace(/\d{4}-\d\d-\d\dT[\d:]+Z/g, "<time>")
				.split("\n"),
			stderr,
		})),
	);

it.skipIf(lan === undefined)(
	"behind a TLS proxy a device is recorded encrypted; a forged X-Forwarded-Proto from elsewhere is not believed",
	async () => {
		const dir = home("proxy");
		const result = await Effect.gen(function* () {
			const real = yield* Clock.Clock;
			return yield* Effect.gen(function* () {
				const listening = yield* port;
				const front = yield* Effect.promise(() => proxy(listening));
				const proxied = routes(`http://127.0.0.1:${front.port}`);
				const direct = routes(`http://127.0.0.1:${listening}`);
				const elsewhere = routes(`http://${lan}:${listening}`);
				const filed = yield* registered(dir);
				const rpc = yield* connect(dir);
				const code = () => Effect.map(rpc["device.pair"]({}), ({ code }) => code);
				const names = new Map<string, string>();
				const secrets = [filed.token];
				const pair = Effect.fn(function* (
					http: ReturnType<typeof routes>,
					name: string,
					headers?: Record<string, string>,
				) {
					const paired = yield* http.pair(yield* code(), name, headers);
					names.set(paired.id, `<${name}>`);
					secrets.push(paired.token);
					return paired;
				});
				const forged = { "x-forwarded-proto": "https" };

				// Through the proxy: paired, a ticket, a socket and a call, each through it.
				const viaProxy = yield* pair(proxied, "Proxied");
				const ticket = yield* proxied.ticket(viaProxy.token);
				secrets.push(ticket);
				const proxiedRpc = yield* device(`ws://127.0.0.1:${front.port}/rpc/v1`, ticket);
				const info = yield* proxiedRpc["server.info"]({});
				yield* pair(direct, "Plain");
				// A tunnel agent on this machine connects from loopback, which is believed.
				yield* pair(direct, "Tunnel", forged);
				// Another address is no proxy this server trusts: its header is any client's.
				const other = yield* pair(elsewhere, "Forged", forged);
				const throughProxy = yield* devicesOf(dir, names);
				// The record is the device's latest request: a ticket taken plainly turns it off.
				yield* direct.ticket(viaProxy.token);
				const afterPlain = yield* devicesOf(dir, names);

				const otherTicket = yield* elsewhere.ticket(other.token, forged);
				secrets.push(otherTicket);
				const refused = {
					"a ticket from another address with a foreign Host": yield* upgrade(listening, otherTicket, lan, {
						Host: "codework.example.com",
					}),
					"a foreign Origin pairing through the proxy": yield* proxied.pairStatus(
						{ code: yield* code(), label: "Evil" },
						{ origin: "https://evil.example" },
					),
					"a foreign Origin opening a socket through the proxy": yield* upgrade(
						front.port,
						yield* proxied.ticket(viaProxy.token),
						undefined,
						{ Origin: "https://evil.example" },
					),
				};
				return {
					secrets,
					artifact: {
						"a call on a socket through the proxy": info.storeId.length > 0,
						devices: throughProxy,
						"after a plain ticket": afterPlain,
						...refused,
					},
				};
			}).pipe(Effect.provide(serve(dir, real, "0.0.0.0")));
		}).pipe(Effect.scoped, Effect.timeout("60 seconds"), Effect.runPromise);
		const text = `${JSON.stringify(result.artifact, null, "\t")}\n`;
		for (const secret of result.secrets) expect(text).not.toContain(secret);
		await expect(text).toMatchFileSnapshot("./__artifacts__/pair.proxy.json");
	},
	60_000,
);

it.skipIf(lan === undefined)(
	"the trusted proxy is --trusted-proxy, else CODEWORK_TRUSTED_PROXY, else the user settings; a bad entry stops the start",
	async () => {
		// A documentation address: no peer of this test comes from it.
		const nobody = "192.0.2.1";
		const setup = (name: string, options: { settings?: unknown; env?: string; project?: unknown }) => {
			const dir = home(`trust-${name}`);
			if (options.settings !== undefined)
				writeFileSync(join(dir, "settings.jsonc"), JSON.stringify(options.settings));
			const cwd = join(dir, "project");
			mkdirSync(join(cwd, ".codework"), { recursive: true });
			if (options.project !== undefined)
				writeFileSync(join(cwd, ".codework", "settings.jsonc"), JSON.stringify(options.project));
			const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models };
			delete env["CODEWORK_TRUSTED_PROXY"];
			if (options.env !== undefined) env["CODEWORK_TRUSTED_PROXY"] = options.env;
			return { dir, cwd, env };
		};
		/** Whether a device paired from this computer's other address, with a forged header, is recorded encrypted. */
		const believed = async (
			name: string,
			options: { settings?: unknown; env?: string; project?: unknown; flags?: ReadonlyArray<string> },
		) => {
			const { dir, cwd, env } = setup(name, options);
			const served = await serveCli(["--home", dir], {
				cwd,
				env,
				serve: ["--host", "0.0.0.0", ...(options.flags ?? [])],
			});
			const code = (await runCli(["--home", dir, "service", "pair"], { cwd, env })).stdout.trim();
			const response = await fetch(`http://${lan}:${new URL(served.url).port}${Wire.devicesPath}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
				body: JSON.stringify({ code, label: "Laptop" }),
			});
			expect(response.status).toBe(201);
			const listed = (await runCli(["--home", dir, "service", "devices"], { cwd, env })).stdout;
			await served.stop();
			return listed.trim().split("\n").at(-1)?.split(/\s+/).at(-1);
		};
		/** How `codework serve` stops on a bad entry. */
		const refused = async (
			name: string,
			options: { settings?: unknown; env?: string; flags?: ReadonlyArray<string> },
		) => {
			const { dir, cwd, env } = setup(name, options);
			const done = await runCli(["--home", dir, "serve", "--port", "0", ...(options.flags ?? [])], { cwd, env });
			return { status: done.status, stderr: done.stderr.replaceAll(dir, "<home>") };
		};
		const user = (trustedProxy: ReadonlyArray<string>) => ({ server: { trustedProxy } });
		const artifact = {
			"no setting": await believed("none", {}),
			"the user settings name it": await believed("settings", { settings: user([`${lan}/32`]) }),
			"only a project's settings name it": await believed("project", { project: user([lan!]) }),
			"the environment names another over the settings": await believed("env", {
				settings: user([lan!]),
				env: nobody,
			}),
			"the environment names it, comma-separated": await believed("env-list", { env: `${nobody}, ${lan}` }),
			"the flag names it over the environment and settings": await believed("flag", {
				settings: user([nobody]),
				env: nobody,
				flags: ["--trusted-proxy", `${nobody},${lan}`, "--trusted-proxy", "198.51.100.0/24"],
			}),
			"a bad flag entry": await refused("bad-flag", { flags: ["--trusted-proxy", "10.0.0.0/8,proxy.internal"] }),
			"a bad environment entry": await refused("bad-env", { env: "10.0.0.300" }),
			"a bad settings entry": await refused("bad-settings", { settings: user(["10.0.0.0/33"]) }),
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/pair.trust.json");
	},
	180_000,
);
