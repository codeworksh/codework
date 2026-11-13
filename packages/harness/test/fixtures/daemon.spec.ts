import { createAssistantMessageEventStream } from "@codeworksh/aikit";
import { Effect, type Layer, type Scope } from "effect";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as DaemonHost from "../../src/daemon/host.ts";
import * as Git from "../../src/daemon/git.ts";
import * as Skills from "../../src/daemon/skills.ts";
import * as Harness from "../../src/effect/harness.ts";
import * as Sandbox from "../../src/effect/sandbox.ts";
import * as Session from "../../src/effect/session.ts";
import * as SandboxController from "../../src/sandbox/control.ts";
import type { SandboxInstance } from "../../src/sandbox/instance.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import * as Event from "../../src/event/event.ts";
import type * as LLM from "../../src/runner/llm.ts";
import { pendingCall } from "../tools.fixture.ts";
import { assistant } from "./llm.ts";
import { testModel } from "./model.ts";

/** The pinned commit of codeworksh/69th every run starts from. */
export const PINNED = "cdaec6762e3502f6aa3bbf851e855c9ba12b3a6b";
export const REPO = "https://github.com/codeworksh/69th";

/**
 * A model that runs one `bash` command per prompt: the prompt text is the command. The first
 * request of a prompt asks for the call; the request after its result answers and stops.
 */
export const bashModel = (): LLM.Open => {
	let index = 0;
	return (input) =>
		Effect.sync(() => {
			index += 1;
			const messages = input.context.messages;
			const lastUser = messages.findLastIndex((message) => message.role === "user");
			const answered = messages.slice(lastUser + 1).some((message) => message.role === "assistant");
			const prompt = lastUser === -1 || answered ? undefined : messages[lastUser];
			const command =
				prompt === undefined || prompt.role !== "user"
					? undefined
					: prompt.parts
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			const message =
				command === undefined
					? assistant(input, index)
					: assistant(input, index, {
							stopReason: "toolUse",
							parts: [pendingCall("bash", { command }, `call_${index}`)],
						});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: command === undefined ? "stop" : "toolUse", message });
			return stream;
		});
};

export interface Workspace {
	readonly root: string;
	readonly home: string;
}

/** A temp home with the test model selected; removed afterwards. */
export const withWorkspace = async (use: (workspace: Workspace) => Promise<void>) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codework-daemon-e2e-")));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	await fs.writeFile(path.join(home, "settings.jsonc"), JSON.stringify({ model: testModel }));
	try {
		await use({ root, home });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
};

export type Services = Layer.Success<ReturnType<typeof Harness.layer>>;

export const run = <A, E>(
	workspace: Workspace,
	drivers: ReadonlyArray<Sandbox.Driver>,
	program: Effect.Effect<A, E, Services | Scope.Scope>,
) =>
	Effect.runPromise(
		program.pipe(
			Effect.timeout("9 minutes"),
			Effect.scoped,
			Effect.provide(
				Harness.layer({
					database: ":memory:",
					home: workspace.home,
					hostCwd: workspace.root,
					sandboxes: drivers,
					llm: bashModel(),
					daemons: { handover: "5 seconds" },
				}),
			),
		),
	);

type Status = Git.Status["data"];

/**
 * Every `plugin.git.status` published, in order. `settle` returns the last one for a space once
 * it satisfies `until` and nothing newer arrived for a quiet period: a run's refreshes (after each
 * turn and when the drain lets go) can publish more than once, and only the settled one is stable.
 */
export const statuses = Effect.gen(function* () {
	const events = yield* Event.Service;
	const seen: Array<Status> = [];
	const unlisten = yield* events.listen((event) =>
		Effect.sync(() => {
			if (event.type === Git.Status.type) seen.push(event.data as Status);
		}),
	);
	yield* Effect.addFinalizer(() => unlisten);
	const settle = (spaceId: string | undefined, until: (status: Status) => boolean, timeout = 120_000) =>
		Effect.gen(function* () {
			const deadline = Date.now() + timeout;
			for (;;) {
				const mine = seen.filter((status) => spaceId === undefined || status.spaceId === spaceId);
				const latest = mine[mine.length - 1];
				if (latest !== undefined && until(latest)) {
					const count = mine.length;
					yield* Effect.sleep("750 millis");
					const after = seen.filter((status) => spaceId === undefined || status.spaceId === spaceId);
					if (after.length === count) return latest;
					continue;
				}
				if (Date.now() > deadline)
					return yield* Effect.die(
						`no settled git status for ${spaceId ?? "any space"}; last: ${JSON.stringify(latest ?? null)}`,
					);
				yield* Effect.sleep("100 millis");
			}
		});
	return { seen, settle };
});

type SkillList = Skills.List["data"];

/** Every `plugin.skills.list` published; `settle` like {@link statuses}. */
export const skillLists = Effect.gen(function* () {
	const events = yield* Event.Service;
	const seen: Array<SkillList> = [];
	const unlisten = yield* events.listen((event) =>
		Effect.sync(() => {
			if (event.type === Skills.List.type) seen.push(event.data as SkillList);
		}),
	);
	yield* Effect.addFinalizer(() => unlisten);
	const settle = (spaceId: string, until: (list: SkillList) => boolean) =>
		Effect.gen(function* () {
			const deadline = Date.now() + 120_000;
			for (;;) {
				const mine = seen.filter((list) => list.spaceId === spaceId);
				const latest = mine.at(-1);
				if (latest !== undefined && until(latest)) {
					yield* Effect.sleep("750 millis");
					if (seen.filter((list) => list.spaceId === spaceId).length === mine.length) return latest;
					continue;
				}
				if (Date.now() > deadline)
					return yield* Effect.die(`no settled skill list; last: ${JSON.stringify(latest ?? null)}`);
				yield* Effect.sleep("100 millis");
			}
		});
	return { settle };
});

/** Calls the git daemon's `diff` for a space. */
export const diff = (spaceId: string, input: typeof Git.DiffInput.Type = {}) =>
	Effect.gen(function* () {
		const host = yield* DaemonHost.Service;
		return (yield* host.call({ plugin: "git", spaceId, method: "diff", input })) as Git.DiffOutput;
	});

/** A status without its per-run values: `observedAt`, the space id, commit ids made during the run. */
export const stable = (status: Status, heads: Map<string, string>) => {
	// The message is git's own wording, which differs between versions; the reason is ours.
	const { observedAt: _observedAt, spaceId: _spaceId, head, message: _message, ...rest } = status;
	const label =
		head === undefined
			? undefined
			: head === PINNED
				? "<pinned>"
				: (heads.get(head) ?? (heads.set(head, `<commit ${heads.size + 1}>`), heads.get(head)));
	return label === undefined ? rest : { head: label, ...rest };
};

/** Where the scenario runs: the host sandbox, or a provisioned remote one. */
export interface Target {
	readonly drivers?: ReadonlyArray<Sandbox.Driver>;
	readonly provision?: ReturnType<typeof Sandbox.create>;
}

const provisioned = (provision: ReturnType<typeof Sandbox.create>) =>
	Effect.tap(provision, (sandbox) =>
		Effect.addFinalizer(() =>
			Sandbox.stop(sandbox.id).pipe(
				Effect.ignore,
				Effect.andThen(Sandbox.destroy(sandbox.id)),
				Effect.tapCause((cause) => Effect.logWarning(`sandbox ${sandbox.id} may have leaked`, cause)),
				Effect.ignore,
			),
		),
	);

/** Runs `script` in the target's sandbox (taking a lease, as a person editing there would). */
const shell = (sandbox: SandboxInstance.ID | undefined, cwd: string | undefined, script: string) =>
	Effect.gen(function* () {
		const controller = yield* SandboxController.Controller;
		const result = yield* controller.withMount(
			sandbox,
			Effect.gen(function* () {
				const exe = yield* SandboxIO.Shell;
				return yield* exe.exec(script);
			}),
			cwd === undefined ? {} : { cwd },
		);
		if (result.exitCode !== 0)
			return yield* Effect.die(`setup failed (${result.exitCode}): ${result.stderr}${result.stdout}`);
		return result.stdout.trim();
	});

const commit = "git -c user.email=e2e@codework.sh -c user.name=e2e -c commit.gpgsign=false commit -q";

export interface Outcome {
	readonly steps: ReadonlyArray<{
		readonly step: string;
		readonly status?: unknown;
		readonly diff?: unknown;
		readonly skills?: unknown;
	}>;
	/** Remote targets only: what happened to a stopped sandbox when the daemon was asked to read it. */
	readonly wake?: Record<string, unknown>;
}

/**
 * The git daemon against a real clone of codeworksh/69th, changed by real `bash` calls through the
 * runner. Every target records the same steps, so a remote one that diverges from the host fails.
 */
export const gitScenario = (target: Target) => (workspace: Workspace) =>
	run(
		workspace,
		target.drivers ?? [],
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const sandbox = target.provision === undefined ? undefined : yield* provisioned(target.provision);
			const id = sandbox?.id;
			const base =
				id === undefined
					? workspace.root
					: yield* shell(id, undefined, `dir=daemon-e2e-${Date.now()} && mkdir -p "$dir" && cd "$dir" && pwd`);
			const repo = `${base}/69th`;
			const plain = `${base}/plain`;
			yield* shell(
				id,
				base,
				`git clone -q ${REPO} 69th && git -C 69th checkout -q -B main ${PINNED} && mkdir -p plain 69th/sub`,
			);
			const on = sandbox === undefined ? {} : { sandbox };

			const git = yield* statuses;
			const skills = yield* skillLists;
			const heads = new Map<string, string>();
			const steps: Array<Outcome["steps"][number]> = [];
			const record = (step: string, status: Status) => steps.push({ step, status: stable(status, heads) });
			const session = yield* Session.create({ ...on, directory: repo, hostDir: workspace.root });

			yield* session.main.run("git status --short");
			const first = yield* git.settle(undefined, (status) => status.available && status.files.length === 0);
			const spaceId = first.spaceId;
			record("first run: clean clone", first);

			yield* session.main.run(
				"printf 'hello from the daemon e2e\\n' > notes.md && printf 'one more line\\n' >> README.md && mkdir -p docs/deep && printf 'a\\nb\\nc\\n' > docs/deep/new.txt",
			);
			record(
				"edit, add and nest files",
				yield* git.settle(spaceId, (status) => status.files.some((file) => file.file === "notes.md")),
			);

			const patches = yield* diff(spaceId, { files: ["README.md", "notes.md"] });
			steps.push({
				step: "diff of two files",
				diff: patches.files.map((file) => ({ ...file, patch: file.patch.replace(/^index .*$/m, "index <blobs>") })),
			});

			yield* session.main.run(`git add -A && ${commit} -m 'e2e: notes'`);
			record("commit everything", yield* git.settle(spaceId, (status) => status.files.length === 0));

			yield* session.main.run("git checkout -q -b feature/e2e && git rm -q --cached README.md && rm README.md");
			record(
				"branch, then delete a tracked file",
				yield* git.settle(spaceId, (status) => status.branch === "feature/e2e"),
			);

			yield* session.main.run("git reset -q --hard && git checkout -q --detach");
			record(
				"reset and detach HEAD",
				yield* git.settle(spaceId, (status) => status.branch === undefined && status.files.length === 0),
			);

			const nested = yield* Session.create({ ...on, directory: `${repo}/sub`, hostDir: workspace.root });
			yield* nested.main.run("printf 'from a subfolder\\n' > 'here and there.txt'");
			record(
				"a session in a subfolder: a new file in a new folder shows as the folder",
				yield* git.settle(spaceId, (status) => status.files.some((file) => file.file === "sub/")),
			);
			yield* nested.main.run("rm 'here and there.txt'");
			yield* git.settle(spaceId, (status) => status.files.length === 0);

			// A run that fills an untracked folder (an install with no .gitignore entry): one entry, not thousands.
			yield* session.main.run(
				"mkdir -p build-cache && for i in $(seq 1 2000); do echo x > build-cache/f$i.js; done",
			);
			record(
				"an untracked folder of 2000 files",
				yield* git.settle(spaceId, (status) => status.files.some((file) => file.file === "build-cache/")),
			);
			yield* session.main.run("rm -rf build-cache");
			yield* git.settle(spaceId, (status) => status.files.length === 0);

			// Changed outside any run, as an editor would: no event says so. The next mount catches it.
			yield* shell(id, repo, "printf 'typed in an editor\\n' > outside.txt");
			yield* session.main.run("true");
			record(
				"outside edit, picked up on the next run",
				yield* git.settle(spaceId, (status) => status.files.some((file) => file.file === "outside.txt")),
			);

			yield* session.main.run(
				"mkdir -p .agents/skills/deploy && printf -- '---\\nname: deploy\\ndescription: Deploy the 69th app.\\n---\\nSteps.\\n' > .agents/skills/deploy/SKILL.md",
			);
			const added = yield* skills.settle(spaceId, (list) => list.skills.length > 0);
			steps.push({
				step: "a skill added by a run",
				skills: added.skills.map((skill) => ({ ...skill, path: skill.path.replace(repo, "<repo>") })),
			});
			yield* session.main.run("rm -rf .agents");
			const removed = yield* skills.settle(spaceId, (list) => list.skills.length === 0);
			steps.push({ step: "the skill removed by a run", skills: removed.skills });

			const other = yield* Session.create({ ...on, directory: plain, hostDir: workspace.root });
			yield* other.main.run("true");
			record("a space that is not a repository", yield* git.settle(undefined, (status) => !status.available));

			if (id === undefined) return { steps } satisfies Outcome;

			// Remote only: patches past the cache's size, then once the handover closed, a stopped sandbox
			// is never woken by the daemon.
			yield* session.main.run(`for i in 1 2 3; do yes ${"x".repeat(40)} | head -n 12000 > big-$i.txt; done`);
			yield* git.settle(
				spaceId,
				(status) => status.files.filter((file) => file.file.startsWith("big-")).length === 3,
			);
			const wake: Record<string, unknown> = {};
			const released = yield* Effect.gen(function* () {
				for (let attempt = 0; attempt < 120; attempt++) {
					if (!(yield* controller.held(id))) return true;
					yield* Effect.sleep("500 millis");
				}
				return false;
			});
			wake["borrowable after the handover closed"] = !released;
			wake["stopped"] = (yield* controller.stop(id)).status;
			const host = yield* DaemonHost.Service;
			wake["diff on a stopped sandbox"] = yield* host
				.call({ plugin: "git", spaceId, method: "diff", input: {} })
				.pipe(
					Effect.map((output) => {
						const { cached, truncated, files } = output as Git.DiffOutput;
						return cached === true
							? {
									from: "the cache",
									files: files.map((file) => (file.patch === "" ? `${file.file} (left out)` : file.file)),
									truncated: truncated === true,
									"within its size":
										files.reduce((total, file) => total + Buffer.byteLength(file.patch), 0) <=
										Git.MAX_CACHED_PATCH_BYTES,
								}
							: "read live";
					}),
					Effect.catchTag("DaemonCallError", (error) => Effect.succeed(error.reason)),
				);
			wake["diff with other context on a stopped sandbox"] = yield* host
				.call({ plugin: "git", spaceId, method: "diff", input: { context: 10 } })
				.pipe(
					Effect.map(() => "answered"),
					Effect.catchTag("DaemonCallError", (error) => Effect.succeed(error.reason)),
				);
			wake["provider status after that call"] = (yield* controller.refresh(id)).status;
			yield* session.main.run("rm big-*.txt && printf 'after a wake\\n' > woken.txt");
			record(
				"the next run wakes it and the daemon catches up",
				yield* git.settle(spaceId, (status) => status.files.some((file) => file.file === "woken.txt")),
			);
			return { steps, wake } satisfies Outcome;
		}),
	);

/**
 * One session relinked across spaces: a Daytona clone, then a Vercel clone, then a host clone, a
 * change made by a run in each. Every space keeps its own status, a space the session left never
 * picks up a later change, and `diff` answers per space: from the cache for the sandboxes it left,
 * live on the host.
 */
export const relinkScenario = (drivers: ReadonlyArray<Sandbox.Driver>) => (workspace: Workspace) =>
	run(
		workspace,
		drivers,
		Effect.gen(function* () {
			const daytona = yield* provisioned(Sandbox.create({ driver: "daytona", config: { language: "typescript" } }));
			const vercel = yield* provisioned(
				Sandbox.create({ driver: "vercel", config: { runtime: "node24", timeout: 15 * 60 * 1000 } }),
			);
			const clone = (id: SandboxInstance.ID | undefined, base: string) =>
				shell(id, base, `git clone -q ${REPO} 69th && git -C 69th checkout -q -B main ${PINNED}`).pipe(
					Effect.as(`${base}/69th`),
				);
			const base = (id: SandboxInstance.ID) =>
				shell(id, undefined, `dir=daemon-relink-${Date.now()} && mkdir -p "$dir" && cd "$dir" && pwd`);
			const onDaytona = yield* clone(daytona.id, yield* base(daytona.id));
			const onVercel = yield* clone(vercel.id, yield* base(vercel.id));
			const onHost = yield* clone(undefined, workspace.root);

			const git = yield* statuses;
			const heads = new Map<string, string>();
			const record: Record<string, unknown> = {};
			const settleIn = (spaceId: string, file: string) =>
				git.settle(spaceId, (status) => status.files.some((entry) => entry.file === file));
			const seenFor = (spaceId: string) => git.seen.filter((status) => status.spaceId === spaceId).length;

			const session = yield* Session.create({ sandbox: daytona, directory: onDaytona, hostDir: workspace.root });
			const inDaytona = (yield* session.info).spaceId;
			yield* session.main.run("printf 'on daytona\\n' > where.txt");
			record["daytona after its run"] = stable(yield* settleIn(inDaytona, "where.txt"), heads);
			const daytonaPublished = seenFor(inDaytona);

			// Changed after the session left: no drain mounts Daytona again, so its daemon must not publish.
			yield* shell(daytona.id, onDaytona, "printf 'after the session left\\n' > left.txt");
			const toVercel = yield* Session.relink({ sessionId: session.id, sandbox: vercel, directory: onVercel });
			const inVercel = (yield* toVercel.info).spaceId;
			yield* toVercel.main.run("printf 'on vercel\\n' > where.txt && printf 'from vercel\\n' >> README.md");
			record["vercel after its run"] = stable(yield* settleIn(inVercel, "README.md"), heads);

			const toHost = yield* Session.relink({ sessionId: session.id, directory: onHost });
			const inHost = (yield* toHost.info).spaceId;
			yield* toHost.main.run("printf 'on host\\n' > where.txt && git rm -q README.md");
			record["host after its run"] = stable(
				yield* git.settle(
					inHost,
					(status) => status.files.some((entry) => entry.file === "where.txt") && status.files.length === 2,
				),
				heads,
			);

			record["three distinct spaces"] = new Set([inDaytona, inVercel, inHost]).size === 3;
			record["daytona published nothing after the session left"] = seenFor(inDaytona) === daytonaPublished;

			// The sandboxes the session left stay borrowable for their handover; once it closes, `diff`
			// answers from the cache.
			const controller = yield* SandboxController.Controller;
			const released = (id: SandboxInstance.ID) =>
				Effect.gen(function* () {
					for (let attempt = 0; attempt < 120 && (yield* controller.held(id)); attempt++)
						yield* Effect.sleep("500 millis");
					return !(yield* controller.held(id));
				});
			record["handovers closed"] = { daytona: yield* released(daytona.id), vercel: yield* released(vercel.id) };
			const patch = (spaceId: string) =>
				diff(spaceId, { files: ["where.txt"] }).pipe(
					Effect.map((output) => ({
						cached: output.cached === true,
						lines: output.files.flatMap((file) =>
							file.patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")),
						),
					})),
					Effect.catchTag("DaemonCallError", (error) => Effect.succeed({ error: error.reason })),
				);
			record["diff of where.txt in each space"] = {
				daytona: yield* patch(inDaytona),
				vercel: yield* patch(inVercel),
				host: yield* patch(inHost),
			};
			return record;
		}),
	);
