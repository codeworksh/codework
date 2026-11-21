import { Effect, Stream } from "effect";
import { afterEach, expect, it } from "vite-plus/test";
import { LOCAL_SERVER, type RemoteServerStatus } from "@codeworksh/contract";
import {
	addMachine,
	app,
	cleanup,
	codework,
	freePort,
	query,
	snapshot,
	stable,
	stop,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

afterEach(cleanup);

it("a paired machine shows its host, build and label, goes offline and back unasked, and takes a label", async () => {
	const appHome = tempDir("paired-app");
	const machineHome = tempDir("paired-machine");
	const port = await freePort();
	let machine = await codework(machineHome, port);
	const desk = await app(appHome);
	const id = await addMachine(appHome, machine, desk.run);
	const { version } = await machine.run((rpc) => rpc["server.info"]({}));
	const token = () => query(appHome, "SELECT token FROM machine WHERE id = ?", id)[0]!.token as string | null;
	const session = token()!;

	// Every status `servers.watch` sends; nothing here calls `servers.check`.
	const sent: Array<RemoteServerStatus> = [];
	const watching = desk.background((rpc) =>
		rpc["servers.watch"](undefined).pipe(
			Stream.runForEach((statuses) =>
				Effect.sync(() => {
					const status = statuses.find((candidate) => candidate.id === id);
					if (status?.kind === "remote") sent.push(status);
				}),
			),
		),
	);
	const next = (what: string, test: (status: RemoteServerStatus) => boolean) =>
		waitFor(() => {
			const last = sent.at(-1);
			return last !== undefined && test(last) ? last : undefined;
		}, what);
	const label = (target: string, text: string) =>
		desk.run((rpc) =>
			rpc["servers.label"]({ id: target, label: text }).pipe(
				Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: () => "labelled" }),
			),
		);
	const labelOnMachine = () => machine.run((rpc) => rpc["machine.info"]({})).then(({ givenName }) => givenName);

	const paired = await next("the machine online", (status) => status.online && status.host !== null);
	expect(paired).toMatchObject({ host: "Fixture", label: null, name: "Fixture", version });
	expect(paired.seenAt).toBeTypeOf("number");

	const labelled = { reply: await label(id, "  Build Box  ") };
	const withLabel = await next("the label", (status) => status.label !== null);
	const onMachine = await labelOnMachine();

	const cleared = { reply: await label(id, "   ") };
	const withoutLabel = await next("the label cleared", (status) => status.label === null);
	const clearedOnMachine = await labelOnMachine();

	await stop(machine.proc);
	const offline = await next("the machine offline", (status) => !status.online);
	expect(offline.seenAt).toBeGreaterThanOrEqual(paired.seenAt!);
	const unanswered = await label(id, "Away");

	machine = await codework(machineHome, port);
	const back = await next("the machine back", (status) => status.online);

	const renamed = await desk.run((rpc) =>
		rpc["servers.update"]({ id, name: "Build Box" }).pipe(
			Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: () => "renamed" }),
		),
	);
	const local = await label(LOCAL_SERVER, "Desk");

	const devices = await machine.run((rpc) => rpc["device.list"]({}));
	await machine.run((rpc) => rpc["device.revoke"]({ id: devices[0]!.id }));
	const revoked = await next("the row unpaired", (status) => !status.paired);
	const unpaired = await label(id, "Gone");
	watching.stop();

	expect(token()).toBeNull();
	const text = JSON.stringify({
		"once paired": stable(paired),
		"servers.label": { ...labelled, status: stable(withLabel), "machine.info givenName": onMachine },
		"an empty label": { ...cleared, status: stable(withoutLabel), "machine.info givenName": clearedOnMachine },
		"the machine stopped": { status: stable(offline), "servers.label": unanswered },
		"the machine restarted": stable(back),
		"servers.update with a name": renamed,
		"servers.label on the local server": local,
		"after device.revoke": { status: stable(revoked), "servers.label": unpaired },
	})
		.replaceAll(machine.url, "<machine url>")
		.replaceAll(id, "<machine>");
	for (const secret of [desk.token, machine.token, session]) expect(text).not.toContain(secret);
	await snapshot("paired", JSON.parse(text));
}, 90_000);

it("removing a paired machine ends its pairing there, and a stopped machine's row goes all the same", async () => {
	const appHome = tempDir("leave-app");
	const kept = await codework(tempDir("leave-kept"), await freePort());
	const stopped = await codework(tempDir("leave-stopped"), await freePort());
	const desk = await app(appHome);
	const keptId = await addMachine(appHome, kept, desk.run);
	const stoppedId = await addMachine(appHome, stopped, desk.run);
	const devices = () => kept.run((rpc) => rpc["device.list"]({})).then((list) => list.length);
	const remove = async (id: string) => {
		const started = Date.now();
		const reply = await desk.run((rpc) =>
			rpc["servers.remove"]({ id }).pipe(
				Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: () => "removed" }),
			),
		);
		return { reply, elapsed: Date.now() - started };
	};
	const rows = (id: string) => query(appHome, "SELECT id FROM machine WHERE id = ?", id).length;

	const before = await devices();
	const left = await remove(keptId);
	const after = await devices();

	await stop(stopped.proc);
	const away = await remove(stoppedId);

	await snapshot("paired.remove", {
		"a running machine": { "devices before": before, "servers.remove": left.reply, "devices after": after },
		"a stopped machine": { "servers.remove": away.reply, "within the bound": away.elapsed < 5_000 },
		"rows left": rows(keptId) + rows(stoppedId),
	});
}, 90_000);

// No relay runs here: a connect reaches none, so the machine's own failure is what comes back.
it("a paired machine is linked and unlinked over its own connection, its failures kept and the app's own in its words", async () => {
	const appHome = tempDir("link-app");
	const machineHome = tempDir("link-machine");
	const port = await freePort();
	const relay = `http://127.0.0.1:${await freePort()}`;
	let machine = await codework(machineHome, port, { relay });
	const desk = await app(appHome);
	const id = await addMachine(appHome, machine, desk.run);
	const status = (what: string, test: (status: RemoteServerStatus) => boolean) =>
		waitFor(async () => {
			const statuses = await desk.run((rpc) => rpc["servers.watch"](undefined).pipe(Stream.runHead));
			const found = statuses._tag === "Some" ? statuses.value.find((each) => each.id === id) : undefined;
			return found?.kind === "remote" && test(found) ? found : undefined;
		}, what);
	const reply = <A, E extends { readonly _tag: string; readonly message: string }>(effect: Effect.Effect<A, E>) =>
		effect.pipe(Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: (value) => value }));
	const connect = (serverId: string) =>
		desk.run((rpc) =>
			reply(
				rpc["machine.connect"]({ workspaceId: "acme", serverId }).pipe(
					Stream.runCollect,
					Effect.map((events) => [...events]),
				),
			),
		);
	const disconnect = (serverId: string) =>
		desk.run((rpc) => reply(rpc["machine.disconnect"]({ workspaceId: "acme", keyId: "key", serverId })));

	const before = await status("the machine online", (each) => each.online);
	const connected = await connect(id);
	const disconnected = await disconnect(id);
	const local = await connect(LOCAL_SERVER);

	// The connect gave the machine its id; its status carries it once the machine reports it again.
	const { id: machineId } = await machine.run((rpc) => rpc["machine.info"]({}));
	// A machine that holds its connection open and says nothing: only the wait for its answer ends this.
	machine.proc.kill("SIGSTOP");
	const started = Date.now();
	const silent = await connect(id);
	const bounded = Date.now() - started < 40_000;
	machine.proc.kill("SIGCONT");
	await stop(machine.proc);
	await status("the machine offline", (each) => !each.online);
	const unanswered = await disconnect(id);
	machine = await codework(machineHome, port, { relay });
	const back = await status("the machine back with its id", (each) => each.online && each.machineId !== null);

	const devices = await machine.run((rpc) => rpc["device.list"]({}));
	await machine.run((rpc) => rpc["device.revoke"]({ id: devices[0]!.id }));
	await status("the row unpaired", (each) => !each.paired);
	const unpaired = { connect: await connect(id), disconnect: await disconnect(id) };

	const text = JSON.stringify({
		"once paired": { machineId: before.machineId, workspaces: before.workspaces },
		"machine.connect": connected,
		"machine.disconnect of a workspace it is not linked to": disconnected,
		"machine.connect on the local server by id": local,
		"machine.disconnect while it is stopped": unanswered,
		"machine.connect while it is silent": { reply: silent, "within the bound": bounded },
		"back after its first connect": { machineId: back.machineId, workspaces: back.workspaces },
		"after device.revoke": unpaired,
	})
		.replaceAll(relay, "<relay>")
		.replaceAll(machineId ?? "<none>", "<machine id>");
	await snapshot("paired.link", JSON.parse(text));
}, 150_000);
