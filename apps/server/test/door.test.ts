/* @effect-diagnostics nodeBuiltinImport:off -- the app's own CodeWork home is a path under its temp dir. */
import { Effect, Option, Stream } from "effect";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { LOCAL_SERVER, type ServerStatus } from "@codeworksh/contract";
import { matrix } from "../../../packages/codework/test/utils/knock.ts";
import {
	addMachine,
	app,
	type AppRpc,
	cleanup,
	codework,
	freePort,
	machineRow,
	query,
	snapshot,
	stop,
	synced,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

it("the app server opens its socket only to its page, and a remote machine syncs only while paired", async () => {
	const appHome = tempDir("door-app");
	const goodHome = tempDir("door-good");
	const goodPort = await freePort();
	let good = await codework(goodHome, goodPort);

	const first = await app(appHome);
	const upgrade = await matrix(first.port, "/rpc", first.token, {
		"right token, Origin codework://app": "codework://app",
		"right token, Origin codeworkdev://app": "codeworkdev://app",
	});
	// A row stored before remote machines paired has no session.
	await stop(first.proc);
	write(
		appHome,
		"INSERT INTO machine (id, kind, url, namespace, pos, created_at) VALUES ('stored', 'remote', ?, 'codework', 9, 0)",
		good.url,
	);

	// The app's own CLI home, where its built-in local server registers.
	const localHome = join(appHome, "cli");
	let local = await codework(localHome, await freePort());
	const desk = await app(appHome);
	// A new token per start: the last one opens nothing now.
	const stale = (await matrix(desk.port, "/rpc", first.token))["right token"];
	await synced(appHome, LOCAL_SERVER, local);
	// Restarted on another port with a new token, the local server is found again through its home.
	await stop(local.proc);
	local = await codework(localHome, await freePort());
	await local.run((rpc) => rpc["session.create"]({}));
	await synced(appHome, LOCAL_SERVER, local);
	const statuses = () =>
		desk.run((rpc: AppRpc) => rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow)));
	const remoteOf = (all: ReadonlyArray<ServerStatus>, id: string) => all.find((status) => status.id === id);
	const session = (id: string) =>
		query(appHome, "SELECT token FROM machine WHERE id = ?", id)[0]!.token as string | null;
	const sessions: Array<string> = [];

	const goodId = await addMachine(appHome, good, desk.run);
	sessions.push(session(goodId)!);
	const added = remoteOf(await statuses(), goodId);
	const badCode = await desk.run((rpc) =>
		rpc["servers.add"]({ kind: "remote", name: "Wrong", url: good.url, code: "00000-00000" }).pipe(
			Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: () => "added" }),
		),
	);
	// It can never sync; the time is only how long it is given to show it.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const unpaired = { row: machineRow(appHome, "stored"), status: remoteOf(await statuses(), "stored") };

	// A restart gives the machine a new home token; the row's session outlives it.
	await stop(good.proc);
	good = await codework(goodHome, goodPort);
	await good.run((rpc) => rpc["session.create"]({}));
	await synced(appHome, goodId, good);

	// Revoked on the machine, the row loses its session, and shows it, without being asked.
	const devices = await good.run((rpc) => rpc["device.list"]({}));
	await good.run((rpc) => rpc["device.revoke"]({ id: devices[0]!.id }));
	const revoked = await waitFor(async () => {
		const status = remoteOf(await statuses(), goodId);
		return status?.kind === "remote" && !status.paired ? status : undefined;
	}, "the revoked row to show it is not paired");
	const afterRevoke = { session: session(goodId), status: revoked };

	// Paired again with a new code, it syncs again.
	const code = await good.pair();
	await desk.run((rpc) => rpc["servers.update"]({ id: goodId, code }));
	sessions.push(session(goodId)!);
	await good.run((rpc) => rpc["session.create"]({}));
	await synced(appHome, goodId, good);
	const repaired = remoteOf(await statuses(), goodId);

	const all = await statuses();
	const text = JSON.stringify({
		upgrade,
		"the last start's token": stale,
		"after the local server restarts": { synced: true },
		"a good code": { synced: true, status: added },
		"a wrong code": badCode,
		"a row from before pairing": unpaired,
		"after the machine restarts": { synced: true },
		"after device.revoke": afterRevoke,
		devices: devices.map(({ label }) => ({ label })),
		"paired again": { synced: true, status: repaired, "a new session": sessions[0] !== sessions[1] },
	})
		.replaceAll(good.url, "<good url>")
		.replaceAll(new URL(good.url).host, "<good host>")
		.replaceAll(goodId, "<good>");
	for (const secret of [first.token, desk.token, good.token, local.token, ...sessions])
		expect(text).not.toContain(secret);
	expect(JSON.stringify(all)).not.toContain(sessions[1]!);
	await snapshot("door", JSON.parse(text));
}, 90_000);
