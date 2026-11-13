/* @effect-diagnostics nodeBuiltinImport:off -- the suite clones a repository and runs real servers. */
import { syncTopics } from "@codeworksh/contract";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, expect, it } from "vite-plus/test";
import {
	addMachine,
	app,
	cleanup,
	codework,
	freePort,
	lastSeq,
	notices,
	query,
	snapshot,
	stop,
	synced,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

const REPO = "https://github.com/codeworksh/69th";
const PINNED = "cdaec6762e3502f6aa3bbf851e855c9ba12b3a6b";

afterAll(cleanup);

/*
 * The desktop's Skills section without a read on demand: a real CodeWork server's skills daemon
 * publishes, the app server mirrors it into `space_state` and tells the UI which space changed, and
 * `projects.skills` answers from the mirror.
 */
it("mirrors a space's skills from its daemon into the app and serves them from there", async () => {
	const cwHome = tempDir("daemon-cw");
	const appHome = tempDir("daemon-app");
	const repo = join(tempDir("daemon-repo"), "69th");
	execFileSync("git", ["clone", "-q", REPO, repo], { stdio: "pipe" });
	execFileSync("git", ["-C", repo, "checkout", "-q", "-B", "main", PINNED], { stdio: "pipe" });

	const server = await codework(cwHome, await freePort());
	const created = await server.run((rpc) => rpc["session.create"]({ directory: repo, hostDir: repo as never }));
	const { spaceId, project } = created.session;
	const projectId = project?.id ?? "";
	const prompt = (command: string) =>
		server.run((rpc) =>
			Effect.gen(function* () {
				yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: `bash ${command}` });
				yield* rpc["thread.wait"]({ sessionId: created.session.id });
			}),
		);
	const artifact: Record<string, unknown> = {};

	// Published before the app knows the machine: its replay arrives ahead of the index that mirrors the space.
	await prompt(
		"mkdir -p .agents/skills/deploy && printf -- '---\\nname: deploy\\ndescription: Deploy the 69th app.\\n---\\n' > .agents/skills/deploy/SKILL.md",
	);
	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const stored = () =>
		query(
			appHome,
			"SELECT type, data FROM space_state WHERE machine_id = ? AND space_id = ? ORDER BY type",
			machineId,
			spaceId,
		).map((row) => ({ type: row.type, data: JSON.parse(row.data as string) as Record<string, unknown> }));
	const listed = (until: (count: number) => boolean) => () => {
		const list = stored().find((row) => row.type === "plugin.skills.list");
		return Array.isArray(list?.data.skills) && until(list.data.skills.length) ? list : undefined;
	};
	const skills = () =>
		desk
			.run((rpc) => rpc["projects.skills"]({ machineId, projectId }))
			.then((spaces) =>
				spaces.map((space) => ({ kind: space.space.kind, skills: space.skills, read: space.syncedAt !== null })),
			);
	const stateNotices = (after = 0) =>
		notices(appHome, syncTopics.state, after).filter((notice) => notice.spaceId === spaceId);

	await waitFor(
		listed((count) => count > 0),
		"the skill published before the machine was added",
	);
	artifact["mirrored types"] = stored().map((row) => row.type);
	artifact["projects.skills when the skill came before the machine"] = await skills();

	const before = lastSeq(appHome);
	await prompt("rm -rf .agents");
	await waitFor(
		listed((count) => count === 0),
		"the emptied skill list",
	);
	artifact["projects.skills after a run removed it"] = await skills();
	artifact["a sync/state notice names the space"] = stateNotices(before).some(
		(notice) => notice.type === "plugin.skills.list",
	);

	// A restart replays every space's last event: nothing newer, so nothing is written or noticed.
	// The run's git status can land just after its skills list: count once the notices are quiet.
	let noticed = -1;
	while (noticed !== stateNotices().length) {
		noticed = stateNotices().length;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	await stop(desk.proc);
	desk = await app(appHome);
	await synced(appHome, machineId, server);
	await new Promise((resolve) => setTimeout(resolve, 2000));
	artifact["new sync/state notices after an app restart"] = stateNotices().length - noticed;
	artifact["projects.skills after an app restart"] = await skills();

	await snapshot("daemon.mirror", artifact);
	expect(artifact["a sync/state notice names the space"]).toBe(true);
}, 240_000);
