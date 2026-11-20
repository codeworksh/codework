import { afterEach, expect, it } from "vite-plus/test";
import { matrix } from "../../../packages/codework/test/utils/knock.ts";
import {
	addMachine,
	app,
	cleanup,
	codework,
	freePort,
	machineRow,
	snapshot,
	stop,
	synced,
	tempDir,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

it("the app server opens its socket only to its page, and a remote machine syncs only with its token", async () => {
	const appHome = tempDir("door-app");
	const [good, other] = await Promise.all([
		freePort().then((port) => codework(tempDir("door-good"), port)),
		freePort().then((port) => codework(tempDir("door-other"), port)),
	]);

	const first = await app(appHome);
	const upgrade = await matrix(first.port, "/rpc", first.token, {
		"right token, Origin codework://app": "codework://app",
		"right token, Origin codeworkdev://app": "codeworkdev://app",
	});
	// A row stored before remote machines took a token has none.
	await stop(first.proc);
	write(
		appHome,
		"INSERT INTO machine (id, kind, url, namespace, pos, created_at) VALUES ('stored', 'remote', ?, 'codework', 9, 0)",
		other.url,
	);

	const desk = await app(appHome);
	// A new token per start: the last one opens nothing now.
	const stale = (await matrix(desk.port, "/rpc", first.token))["right token"];
	const goodId = await addMachine(appHome, good, desk.run);
	const wrongId = await desk.run((rpc) =>
		rpc["servers.add"]({ kind: "remote", name: "Wrong", url: other.url, token: "x".repeat(other.token.length) }),
	);
	// Neither can ever sync; the time is only how long they are given to show it.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const refused = { wrong: machineRow(appHome, wrongId), stored: machineRow(appHome, "stored") };
	await desk.run((rpc) => rpc["servers.update"]({ id: wrongId, token: other.token }));
	await synced(appHome, wrongId, other);

	const text = JSON.stringify({
		upgrade,
		"the last start's token": stale,
		"right token": { synced: machineRow(appHome, goodId).store_id !== null },
		"wrong token and none": refused,
		"wrong token, replaced": { synced: machineRow(appHome, wrongId).store_id !== null },
	});
	for (const token of [first.token, desk.token, good.token, other.token]) expect(text).not.toContain(token);
	await snapshot("door", JSON.parse(text));
}, 60_000);
