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
