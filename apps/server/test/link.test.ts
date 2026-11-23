import { type Machine, Relay } from "@codeworksh/schema";
import { Effect, Schema, Stream } from "effect";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { clerkUser, newRun, secretKey, startRelay } from "../../../infra/relay/test/utils.ts";
import { addMachine, app, cleanup, codework, freePort, snapshot, tempDir, waitFor, watchOf } from "./fixtures/apps.ts";

const decodeMe = Schema.decodeUnknownSync(Relay.Me);
const decodeMachines = Schema.decodeUnknownSync(Schema.Array(Relay.Machine));

const run = newRun();
let relay: Awaited<ReturnType<typeof startRelay>>;
let user: Awaited<ReturnType<typeof clerkUser>>;

const asPerson = async (path: string, init: RequestInit = {}) =>
	fetch(`${relay.base}${path}`, {
		...init,
		headers: { authorization: `Bearer ${await user.token()}`, "content-type": "application/json" },
	});

describe.skipIf(secretKey === undefined)("linking a paired machine through Relay", () => {
	beforeAll(async () => {
		relay = await startRelay(run);
		user = await clerkUser(run);
	});

	afterAll(async () => {
		await cleanup();
		await user?.remove();
		relay?.stop();
	});

	it("links and unlinks it, and an unlink while Relay is down finishes once Relay is back", async () => {
		const workspace = decodeMe(await (await asPerson("/v1/me")).json()).workspaces[0]!;
		const appHome = tempDir("link-app");
		const machine = await codework(tempDir("link-machine"), await freePort(), { relay: relay.base });
		const desk = await app(appHome);
		const id = await addMachine(appHome, machine, desk.run);
		const status = watchOf(desk, id);

		const listed = async () =>
			decodeMachines(await (await asPerson(`/v1/workspaces/${workspace.id}/machines`)).json()).map(
				({ id, keyId, online }) => ({ id, keyId, online }),
			);
		const own = () => machine.run((rpc) => rpc["machine.info"]({})).then(({ workspaces }) => workspaces);
		// Through the app server, as the desktop app links a paired machine: the code, then the link once approved.
		const link = async () => {
			const events: Array<Machine.ConnectEvent> = [];
			const connecting = desk.background((rpc) =>
				rpc["machine.connect"]({ workspaceId: workspace.id, serverId: id }).pipe(
					Stream.runForEach((event) => Effect.sync(() => events.push(event))),
				),
			);
			const code = await waitFor(
				() => events.flatMap((event) => (event._tag === "Code" ? [event.userCode] : []))[0],
				"the connect code",
			);
			const approved = await asPerson(`/v1/workspaces/${workspace.id}/pairings/approve`, {
				method: "POST",
				body: JSON.stringify({ userCode: code }),
			});
			await connecting.done;
			const keyId = (await own()).find((each) => each.id === workspace.id)?.keyId;
			return { events: events.map((event) => event._tag), approve: approved.status, keyId };
		};
		const unlink = (keyId: string | undefined) =>
			desk
				.run((rpc) => rpc["machine.disconnect"]({ workspaceId: workspace.id, keyId: keyId ?? "", serverId: id }))
				.then(({ revoked, status }) => ({ revoked, workspaces: status.workspaces }));
		const revokedAt = () =>
			relay.psql(`SELECT coalesce(revoked_at::text, 'none') FROM machine WHERE id = '${machineId}'`) === "none"
				? "not revoked"
				: "revoked";

		const first = await link();
		const machineId = (await machine.run((rpc) => rpc["machine.info"]({}))).id;
		const linked = await status("the link in the app's status", (each) => each.workspaces.length === 1);
		// The connect sends a heartbeat at once, so Relay sees it online.
		const online = await waitFor(async () => {
			const list = await listed();
			return list.some((each) => each.online) ? list : undefined;
		}, "the machine online at Relay");
		const unlinkedUp = await unlink(first.keyId);
		const afterUp = await status("no link in the app's status", (each) => each.workspaces.length === 0);
		const listedAfterUp = await listed();

		const second = await link();
		await status("the second link in the app's status", (each) => each.workspaces.length === 1);
		await relay.down();
		const unlinkedDown = await unlink(second.keyId);
		const leaving = await status("the link leaving", (each) => each.workspaces.some((link) => link.leaving));
		const ownLeaving = await own();
		const atRelayWhileDown = revokedAt();

		await relay.up();
		// Each heartbeat, every 30 seconds, asks Relay to revoke a leaving link until it confirms.
		const ownAfter = await waitFor(
			async () => {
				const workspaces = await own();
				return workspaces.length === 0 ? workspaces : undefined;
			},
			"the machine to drop the link once Relay confirms",
			45_000,
		);

		const text = JSON.stringify({
			"first link": {
				"connect events": first.events,
				"approve status": first.approve,
				"app status": linked.workspaces,
				relay: online,
			},
			"unlink with Relay up": { reply: unlinkedUp, "app status": afterUp.workspaces, relay: listedAfterUp },
			"second link": { "connect events": second.events, "approve status": second.approve },
			"unlink with Relay down": {
				reply: unlinkedDown,
				"app status": leaving.workspaces,
				"machine's own record": ownLeaving,
				"relay row": atRelayWhileDown,
			},
			"Relay back": { "machine's own record": ownAfter, relay: await listed(), "relay row": revokedAt() },
		})
			.replaceAll(workspace.id, "<workspace>")
			.replaceAll(machineId ?? "<none>", "<machine id>")
			.replaceAll(first.keyId ?? "<none>", "<key 1>")
			.replaceAll(second.keyId ?? "<none>", "<key 2>");
		await snapshot("link", JSON.parse(text));
	}, 180_000);
});
