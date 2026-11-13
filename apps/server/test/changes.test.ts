/* @effect-diagnostics nodeBuiltinImport:off -- the suite clones a repository and runs real servers. */
import type { ChangesSpace, SpaceChanges } from "@codeworksh/contract";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vite-plus/test";
import {
	addMachine,
	app,
	cleanup,
	codework,
	freePort,
	normalizer,
	snapshot,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

const REPO = "https://github.com/codeworksh/69th";
const PINNED = "cdaec6762e3502f6aa3bbf851e855c9ba12b3a6b";

afterAll(cleanup);

/*
 * The desktop's Git Changes panel: a real CodeWork server's git daemon publishes each run's working
 * tree, the app mirrors it for `changes.status`, and `changes.diff` asks the daemon for the patches.
 */
it("serves a space's changes from the git daemon's mirror and its patches from the daemon", async () => {
	const cwHome = tempDir("changes-cw");
	const appHome = tempDir("changes-app");
	const repo = join(tempDir("changes-repo"), "69th");
	execFileSync("git", ["clone", "-q", REPO, repo], { stdio: "pipe" });
	execFileSync("git", ["-C", repo, "checkout", "-q", "-B", "main", PINNED], { stdio: "pipe" });
	// A second project whose space no run has mounted, with one untracked file.
	const idle = tempDir("changes-idle");
	execFileSync("git", ["init", "-q", idle], { stdio: "pipe" });
	writeFileSync(join(idle, "idea.txt"), "one\n");

	const server = await codework(cwHome, await freePort());
	const created = await server.run((rpc) => rpc["session.create"]({ directory: repo, hostDir: repo as never }));
	const other = await server.run((rpc) => rpc["session.create"]({ directory: idle, hostDir: idle as never }));
	const { spaceId } = created.session;
	const prompt = (command: string) =>
		server.run((rpc) =>
			Effect.gen(function* () {
				yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: `bash ${command}` });
				yield* rpc["thread.wait"]({ sessionId: created.session.id });
			}),
		);
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const status = (space = spaceId) => desk.run((rpc) => rpc["changes.status"]({ machineId, spaceId: space }));
	const diff = (files?: ReadonlyArray<string>) =>
		desk.run((rpc) => rpc["changes.diff"]({ machineId, spaceId, ...(files === undefined ? {} : { files }) }));
	const shown = ({ observedAt, ...changes }: SpaceChanges) => ({ ...changes, observed: observedAt > 0 });
	const artifact: Record<string, unknown> = {};

	artifact["changes.status before any run"] = await status();

	await prompt("printf 'Edited by a run.\\n' >> README.md && printf 'hello\\nworld\\n' > notes.txt");
	const edited = await waitFor(
		() => status().then((read) => (read !== null && read.files.length === 2 ? read : undefined)),
		"the run's two changed files",
	);
	artifact["changes.status after a run edited README.md and added notes.txt"] = shown(edited);
	// The host is always readable, so these are live reads, never the patches kept for a detached space.
	artifact["changes.diff"] = await diff();
	artifact["changes.diff of notes.txt"] = await diff(["notes.txt"]);

	const line = await desk.run((rpc) => rpc["threads.line"]({ sessionId: created.session.id, limit: 0 }));
	artifact["threads.line carries the session's space"] = line.thread.spaceId === spaceId;

	// The panel's context row: the folder, where it is, and every thread sharing its working tree.
	const space = (id = spaceId) => desk.run((rpc) => rpc["changes.space"]({ machineId, spaceId: id }));
	const placed = ({ threads, ...where }: ChangesSpace) => ({
		...where,
		threads: threads.map(({ updatedAt, ...thread }) => ({ ...thread, updated: updatedAt > 0 })),
	});
	const alone = await space();
	artifact["changes.space of the host folder with its one thread"] = alone === null ? null : placed(alone);
	const second = await server.run((rpc) => rpc["session.create"]({ directory: repo, hostDir: repo as never }));
	const shared = await waitFor(
		() => space().then((read) => (read !== null && read.threads.length === 2 ? read : undefined)),
		"the second session's thread in the same space",
	);
	artifact["changes.space after a second session in the same folder"] = placed(shared);
	artifact["the second session shares the space"] = second.session.spaceId === spaceId;
	artifact["changes.space of an unknown space"] = await space("missing");

	artifact["changes.status of a space no run mounted"] = await status(other.session.spaceId);
	// A local space wakes nothing when read, so the call starts its git daemon.
	artifact["changes.diff of a local space no run mounted"] = await desk.run((rpc) =>
		rpc["changes.diff"]({ machineId, spaceId: other.session.spaceId }),
	);

	await prompt("git checkout -- . && git clean -fd");
	const reverted = await waitFor(
		() => status().then((read) => (read !== null && read.files.length === 0 ? read : undefined)),
		"the reverted working tree",
	);
	artifact["changes.status after a run reverted everything"] = shown(reverted);

	await snapshot(
		"changes",
		normalizer(
			[cwHome, appHome, repo, idle],
			[
				[spaceId, "<space 1>"],
				[other.session.spaceId, "<space 2>"],
				// An untitled session is named by its slug, which is random.
				[second.session.slug, "<slug>"],
			],
		)(artifact),
	);
	expect(artifact["threads.line carries the session's space"]).toBe(true);
}, 240_000);
