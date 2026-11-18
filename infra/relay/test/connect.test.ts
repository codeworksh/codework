/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real codework CLI and server. */
import { Relay } from "@codeworksh/schema";
import { Schema } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { clerkUser, newRun, secretKey, startRelay, waitForLine } from "./utils.ts";

const run = newRun();
const cli = fileURLToPath(new URL("../../../packages/codework/src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-connect-"));
const decodeMe = Schema.decodeUnknownSync(Relay.Me);
const decodeMachines = Schema.decodeUnknownSync(Schema.Array(Relay.Machine));
const decodeApproved = Schema.decodeUnknownSync(Schema.Struct({ machine: Relay.MachineInfo }));
const decodeError = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }));

let relay: Awaited<ReturnType<typeof startRelay>>;
let user: Awaited<ReturnType<typeof clerkUser>>;
const children: Array<ChildProcess> = [];

/**
 * `stderr` pipes it for {@link finished} to read; a long-running server leaves it inherited. `relayUrl`
 * points the CLI's new connects at another relay.
 */
const codework = (
	args: ReadonlyArray<string>,
	options: { readonly stderr?: boolean; readonly relayUrl?: string } = {},
) => {
	const child = spawn(process.execPath, ["--conditions=development", cli, ...args, "--home", home], {
		env: { ...process.env, CODEWORK_RELAY_URL: options.relayUrl ?? relay.base },
		stdio: ["ignore", "pipe", options.stderr === true ? "pipe" : "inherit"],
	});
	children.push(child);
	return child;
};

const finished = (child: ChildProcess) =>
	new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
		let out = "";
		let err = "";
		child.stdout!.on("data", (chunk) => (out += chunk));
		child.stderr?.on("data", (chunk) => (err += chunk));
		child.once("exit", (code) => resolve({ code, out, err }));
	});

const asPerson = async (path: string, init: RequestInit = {}) =>
	fetch(`${relay.base}${path}`, {
		...init,
		headers: { authorization: `Bearer ${await user.token()}`, "content-type": "application/json" },
	});

const machines = async (workspaceId: string) =>
	decodeMachines(await (await asPerson(`/v1/workspaces/${workspaceId}/machines`)).json());

const until = async <A>(probe: () => Promise<A | undefined>, timeout = 20_000): Promise<A> => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("timed out");
};

const machineFile = () => JSON.parse(readFileSync(join(home, "machine.json"), "utf8"));

describe.skipIf(secretKey === undefined)("codework connect", () => {
	beforeAll(async () => {
		relay = await startRelay(run);
		user = await clerkUser(run);
	});

	afterAll(async () => {
		for (const child of children) child.kill("SIGKILL");
		await user?.remove();
		relay?.stop();
		rmSync(home, { recursive: true, force: true });
	});

	it("pairs, heartbeats and disconnects a machine", async () => {
		const me = decodeMe(await (await asPerson("/v1/me")).json());
		const workspace = me.workspaces[0]!;

		// Connect: the CLI registers its key and shows a code; a member approves it.
		const connect = codework(["connect", "--workspace", workspace.id, "--machine-id", "e2e-box"]);
		const connectDone = finished(connect);
		const code = await waitForLine(connect, (line) => /code ([A-Z]{4}-[A-Z]{4})/.exec(line)?.[1]);
		const approve = await asPerson("/v1/pairings/approve", {
			method: "POST",
			body: JSON.stringify({ userCode: code, workspaceId: workspace.id }),
		});
		const approved = decodeApproved(await approve.json()).machine;
		const connected = await connectDone;
		const reused = await asPerson("/v1/pairings/approve", {
			method: "POST",
			body: JSON.stringify({ userCode: code, workspaceId: workspace.id }),
		});

		const file = machineFile();
		const link = file.workspaces[workspace.id];
		const beforeServe = await machines(workspace.id);

		// Serve: its first heartbeat marks the machine online.
		const serve = codework(["serve", "--port", "0"]);
		const online = await until(async () => (await machines(workspace.id)).find((machine) => machine.online));
		serve.kill("SIGTERM");

		// A forged heartbeat (wrong key for this kid) is refused.
		const forged = await fetch(`${relay.base}/v1/machines/heartbeat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jws: `${btoa(JSON.stringify({ alg: "EdDSA", kid: link.keyId })).replace(/=+$/, "")}.e30.AAAA`,
			}),
		});

		// Disconnect: the relay revokes the link and the home forgets it.
		const disconnected = await finished(codework(["disconnect"]));
		const afterDisconnect = await machines(workspace.id);

		const artifact = {
			connect: {
				exitCode: connected.code,
				output: connected.out.replace(code, "<code>"),
				approveStatus: approve.status,
				approved: { id: approved.id, source: approved.source },
				reusedCode: { status: reused.status, tag: decodeError(await reused.json())._tag },
			},
			machineFile: {
				id: file.id,
				source: file.source,
				mode: (statSync(join(home, "machine.json")).mode & 0o777).toString(8),
				workspaces: Object.keys(file.workspaces).map((id) => (id === workspace.id ? "<workspace>" : id)),
				link: {
					name: link.name,
					ownerName: link.owner.name,
					relay: link.relay === relay.base ? "<relay>" : link.relay,
					keyKty: link.key.kty,
					keyCrv: link.key.crv,
				},
			},
			machinesBeforeServe: beforeServe.map((machine) => ({
				id: machine.id,
				online: machine.online,
				ownerIsApprover: machine.ownerId === me.account.id,
				keyIsLinkKey: machine.keyId === link.keyId,
			})),
			online: { id: online.id, online: online.online, version: online.version.length > 0 },
			forgedHeartbeat: { status: forged.status, tag: decodeError(await forged.json())._tag },
			disconnect: {
				exitCode: disconnected.code,
				output: disconnected.out,
				machineFileWorkspaces: Object.keys(machineFile().workspaces),
				machinesAfter: afterDisconnect.length,
				revokedRows: Number(relay.psql("SELECT count(*) FROM machine WHERE revoked_at IS NOT NULL")),
			},
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/connect.json");
	});

	it("declines a connect, accepts a code typed without its dash, and removes a machine", async () => {
		const me = decodeMe(await (await asPerson("/v1/me")).json());
		const workspace = me.workspaces[0]!;
		const pending = async () =>
			Schema.decodeUnknownSync(Schema.Array(Relay.PendingPairing))(
				await (await asPerson(`/v1/workspaces/${workspace.id}/pairings`)).json(),
			);

		// A connect that names the workspace waits in its list; declining it stops the CLI with "declined".
		const asked = codework(["connect", "--workspace", workspace.id], { stderr: true });
		const askedDone = finished(asked);
		const askedCode = await waitForLine(asked, (line) => /code ([A-Z]{4}-[A-Z]{4})/.exec(line)?.[1]);
		const listed = await pending();
		const decline = await asPerson("/v1/pairings/decline", {
			method: "POST",
			body: JSON.stringify({ userCode: askedCode, workspaceId: workspace.id }),
		});
		const declined = await askedDone;
		const afterDecline = await pending();

		// The code as a person may type it: lower case, no dash.
		const connect = codework(["connect", "--workspace", workspace.id]);
		const connectDone = finished(connect);
		const code = await waitForLine(connect, (line) => /code ([A-Z]{4}-[A-Z]{4})/.exec(line)?.[1]);
		const approve = await asPerson("/v1/pairings/approve", {
			method: "POST",
			body: JSON.stringify({ userCode: code.replace("-", "").toLowerCase(), workspaceId: workspace.id }),
		});
		const connected = await connectDone;

		// Removed while its server is down, the machine forgets the link on its first heartbeat back.
		const remove = await asPerson(`/v1/workspaces/${workspace.id}/machines/e2e-box/remove`, { method: "POST" });
		const afterRemove = await machines(workspace.id);
		const serve = codework(["serve", "--port", "0"]);
		const forgotten = await until(async () =>
			Object.keys(machineFile().workspaces).length === 0 ? true : undefined,
		);
		serve.kill("SIGTERM");
		const removedAgain = await asPerson(`/v1/workspaces/${workspace.id}/machines/e2e-box/remove`, {
			method: "POST",
		});

		// Ids that aren't a workspace's fail plainly: before any request, at the relay, and at the wire.
		const badWorkspace = await finished(codework(["connect", "--workspace", "typo-123"], { stderr: true }));
		const unknownWorkspace = await finished(
			codework(["connect", "--workspace", "01a1ead7-0000-7000-8000-000000000000"], { stderr: true }),
		);
		const badParam = await asPerson("/v1/workspaces/typo/machines");

		const artifact = {
			decline: {
				listed: listed.map((pairing) => ({
					code: pairing.userCode === askedCode ? "<code>" : pairing.userCode,
					machine: pairing.machine.id,
					status: pairing.status,
					replaces: pairing.replaces,
				})),
				status: decline.status,
				exitCode: declined.code,
				error: declined.err.trim(),
				pendingAfter: afterDecline.length,
			},
			typedCode: { status: approve.status, exitCode: connected.code, output: connected.out.replace(code, "<code>") },
			remove: {
				status: remove.status,
				machinesAfter: afterRemove.length,
				machineFileForgot: forgotten,
				again: { status: removedAgain.status, tag: decodeError(await removedAgain.json())._tag },
			},
			badWorkspace: { exitCode: badWorkspace.code, error: badWorkspace.err.trim() },
			unknownWorkspace: { exitCode: unknownWorkspace.code, error: unknownWorkspace.err.trim() },
			badParam: { status: badParam.status },
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/manage.json");
	});

	it("never links an abandoned connect, and lets one of two competing connects win", async () => {
		const me = decodeMe(await (await asPerson("/v1/me")).json());
		const workspace = me.workspaces[0]!;
		const approve = (userCode: string) =>
			asPerson("/v1/pairings/approve", {
				method: "POST",
				body: JSON.stringify({ userCode, workspaceId: workspace.id }),
			});
		const started = async () => {
			const child = codework(["connect", "--workspace", workspace.id], { stderr: true });
			const done = finished(child);
			const code = await waitForLine(child, (line) => /code ([A-Z]{4}-[A-Z]{4})/.exec(line)?.[1]);
			return { child, done, code };
		};

		// A connect killed while its code is pending, approved anyway before its lease lapses: nobody holds
		// its key, so it never links. A second connect approved after it links and supersedes it.
		const abandoned = await started();
		abandoned.child.kill("SIGKILL");
		const raceApprove = await approve(abandoned.code);
		const kept = await started();
		await approve(kept.code);
		const keptDone = await kept.done;
		const serve = codework(["serve", "--port", "0"]);
		const online = await until(async () => (await machines(workspace.id)).find((machine) => machine.online));
		serve.kill("SIGTERM");
		const link = machineFile().workspaces[workspace.id];

		// A connect that stops polling drops out of Waiting to Join and its code can't be approved.
		const stale = await started();
		stale.child.kill("SIGKILL");
		const listed = Schema.decodeUnknownSync(Schema.Array(Relay.PendingPairing));
		await until(async () => {
			const list = listed(await (await asPerson(`/v1/workspaces/${workspace.id}/pairings`)).json());
			return list.some((pairing) => pairing.userCode === stale.code) ? undefined : true;
		}, 40_000);
		const staleApprove = await approve(stale.code);

		// Two live connects for one machine, both approved: the first to poll links, the other is told.
		const [first, second] = await Promise.all([started(), started()]);
		await Promise.all([approve(first.code), approve(second.code)]);
		const outcomes = (await Promise.all([first.done, second.done]))
			.map((result) => ({ exitCode: result.code, error: result.err.trim() }))
			.sort((a, b) => (a.exitCode ?? 0) - (b.exitCode ?? 0));

		const artifact = {
			kept: { exitCode: keptDone.code },
			raceApprove: { status: raceApprove.status },
			afterRace: {
				online: online.online,
				relayKeyIsLocalKey: online.keyId === link.keyId,
				machineFileWorkspaces: Object.keys(machineFile().workspaces).length,
			},
			stale: { status: staleApprove.status, error: decodeError(await staleApprove.json())._tag },
			competing: outcomes,
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/abandon.json");
	}, 150_000);

	it("keeps links made with one relay when the CLI is pointed at another", async () => {
		const workspace = decodeMe(await (await asPerson("/v1/me")).json()).workspaces[0]!;
		const other = await startRelay(`${run}b`);
		try {
			// The machine is linked (previous case); its server now runs with new connects aimed elsewhere.
			const before = Object.keys(machineFile().workspaces);
			const seen = () =>
				relay.psql(
					`SELECT coalesce(max(last_seen_at)::text, '') FROM machine WHERE workspace_id = '${workspace.id}'`,
				);
			const seenBefore = seen();
			const serve = codework(["serve", "--port", "0"], { relayUrl: other.base });
			const beat = await until(async () => (seen() > seenBefore ? true : undefined));
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			serve.kill("SIGTERM");
			const artifact = {
				linkedBefore: before.length,
				heartbeatReachedItsRelay: beat,
				linkedAfter: Object.keys(machineFile().workspaces).length,
				machinesOnOtherRelay: Number(other.psql("SELECT count(*) FROM machine")),
			};
			await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/relays.json");
		} finally {
			other.stop();
		}
	});
});
