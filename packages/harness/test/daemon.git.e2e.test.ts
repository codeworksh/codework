import { expect, it } from "vite-plus/test";
import * as Sandbox from "../src/effect/sandbox.ts";
import * as DaytonaDriver from "../src/sandboxes/daytona/index.ts";
import * as VercelDriver from "../src/sandboxes/vercel/index.ts";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import * as Session from "../src/effect/session.ts";
import { gitScenario, PINNED, REPO, relinkScenario, run, statuses, withWorkspace } from "./fixtures/daemon.spec.ts";
import { remoteSuite } from "./fixtures/live.ts";
import { hasLiveOidc } from "./fixtures/vercel.ts";
import "./utils/env.ts";

const TIMEOUT = 900_000;

const gitScenarioClone = async (into: string) => {
	execFileSync("git", ["clone", "-q", REPO, into], { stdio: "pipe" });
	execFileSync("git", ["-C", into, "checkout", "-q", "-B", "main", PINNED], { stdio: "pipe" });
};

/*
 * The git daemon on a real clone of codeworksh/69th, changed by real `bash` calls through the
 * runner. Host and every remote sandbox record the same steps into one artifact; a remote one also
 * shows that a stopped sandbox is never woken by the daemon.
 */
it(
	"keeps a host space's git status current across runs, commits, branches and outside edits",
	() =>
		withWorkspace(async (workspace) => {
			const outcome = await gitScenario({})(workspace);
			await expect(JSON.stringify(outcome.steps, null, "\t")).toMatchFileSnapshot(
				"./__artifacts__/daemon.git.e2e.json",
			);
		}),
	TIMEOUT,
);

it(
	"two threads running in one space at once: both changes land in one settled status",
	() =>
		withWorkspace(async (workspace) => {
			const repo = `${workspace.root}/69th`;
			await gitScenarioClone(repo);
			const outcome = await run(
				workspace,
				[],
				Effect.gen(function* () {
					const git = yield* statuses;
					const first = yield* Session.create({ directory: repo, hostDir: workspace.root });
					const second = yield* Session.create({ directory: repo, hostDir: workspace.root });
					yield* Effect.all(
						[
							first.main.run("sleep 1 && printf 'one\\n' > from-first.txt"),
							second.main.run("sleep 1 && printf 'two\\n' > from-second.txt"),
						],
						{ concurrency: "unbounded" },
					);
					const settled = yield* git.settle(undefined, (status) => status.files.length === 2);
					return {
						files: settled.files,
						"statuses published": git.seen.length <= 4 ? "at most 4" : `${git.seen.length}`,
					};
				}),
			);
			await expect(JSON.stringify(outcome, null, "\t")).toMatchFileSnapshot(
				"./__artifacts__/daemon.git.concurrent.json",
			);
		}),
	TIMEOUT,
);

remoteSuite("DAYTONA_API_KEY", Boolean(process.env.DAYTONA_API_KEY?.trim()))("space daemons — daytona", () => {
	it(
		"keeps a daytona space's git status current and never wakes a stopped sandbox",
		() =>
			withWorkspace(async (workspace) => {
				const outcome = await gitScenario({
					drivers: [DaytonaDriver.make()],
					provision: Sandbox.create({ driver: "daytona", config: { language: "typescript" } }),
				})(workspace);
				const shared = outcome.steps.slice(0, -1);
				await expect(JSON.stringify(shared, null, "\t")).toMatchFileSnapshot("./__artifacts__/daemon.git.e2e.json");
				await expect(
					JSON.stringify({ wake: outcome.wake, after: outcome.steps.at(-1) }, null, "\t"),
				).toMatchFileSnapshot("./__artifacts__/daemon.git.daytona.wake.json");
			}),
		TIMEOUT,
	);
});

remoteSuite("VERCEL_OIDC_TOKEN", hasLiveOidc(process.env.VERCEL_OIDC_TOKEN))("space daemons — vercel", () => {
	it(
		"keeps a vercel space's git status current and never wakes a stopped sandbox",
		() =>
			withWorkspace(async (workspace) => {
				const outcome = await gitScenario({
					drivers: [VercelDriver.make()],
					provision: Sandbox.create({ driver: "vercel", config: { runtime: "node24", timeout: 15 * 60 * 1000 } }),
				})(workspace);
				const shared = outcome.steps.slice(0, -1);
				await expect(JSON.stringify(shared, null, "\t")).toMatchFileSnapshot("./__artifacts__/daemon.git.e2e.json");
				await expect(
					JSON.stringify({ wake: outcome.wake, after: outcome.steps.at(-1) }, null, "\t"),
				).toMatchFileSnapshot("./__artifacts__/daemon.git.vercel.wake.json");
			}),
		TIMEOUT,
	);
});

remoteSuite(
	"VERCEL_OIDC_TOKEN and DAYTONA_API_KEY",
	hasLiveOidc(process.env.VERCEL_OIDC_TOKEN) && Boolean(process.env.DAYTONA_API_KEY?.trim()),
)("space daemons — relink daytona → vercel → host", () => {
	it(
		"attributes each run to the space the session is on, and keeps every space's own state",
		() =>
			withWorkspace(async (workspace) => {
				const outcome = await relinkScenario([DaytonaDriver.make(), VercelDriver.make()])(workspace);
				await expect(JSON.stringify(outcome, null, "\t")).toMatchFileSnapshot(
					"./__artifacts__/daemon.git.relink.json",
				);
			}),
		TIMEOUT,
	);
});
