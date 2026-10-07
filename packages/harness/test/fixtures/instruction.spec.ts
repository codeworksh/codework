import { Effect, type Layer, type Scope } from "effect";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vite-plus/test";
import { Harness } from "../../src/effect/harness.ts";
import { Sandbox } from "../../src/effect/sandbox.ts";
import { Session } from "../../src/effect/session.ts";
import { Git } from "../../src/git/git.ts";
import { SandboxController } from "../../src/sandbox/control.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { immediateOpen } from "./llm.ts";

const context = (text: string) => /<project_context>\n[\s\S]*?\n<\/project_context>/.exec(text)?.[0];

export interface Target {
	readonly drivers?: ReadonlyArray<Sandbox.Driver>;
	/** Undefined runs on the host sandbox. */
	readonly provision?: ReturnType<typeof Sandbox.create>;
}

interface Host {
	readonly root: string;
	readonly anchor: string;
	readonly off: string;
	/** Where the host sandbox mounts; `hostCwd` would otherwise be its cwd. */
	readonly sandbox: string;
}

/** Host-side directories whose instruction files must never reach a prompt. */
const withHost = async (use: (host: Host) => Promise<void>) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codework-instruction-e2e-"));
	const write = async (file: string, text: string) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
	};
	try {
		await write(path.join(root, "home", "AGENTS.md"), "Home: never shown.\n");
		await write(path.join(root, "cwd", "AGENTS.md"), "Host cwd: never shown.\n");
		await write(path.join(root, "anchor", "AGENTS.md"), "Host dir: never shown.\n");
		await write(path.join(root, "anchor", ".codework", "settings.jsonc"), "{}");
		await write(path.join(root, "off", "AGENTS.md"), "Host dir: never shown.\n");
		await write(
			path.join(root, "off", ".codework", "settings.jsonc"),
			JSON.stringify({ plugins: [{ plugin: "codework.prompt.instruction", enabled: false }] }),
		);
		await fs.mkdir(path.join(root, "sandbox"));
		await use({
			root,
			anchor: path.join(root, "anchor"),
			off: path.join(root, "off"),
			sandbox: path.join(root, "sandbox"),
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
};

type Services = Layer.Success<ReturnType<typeof Harness.layer>>;

const run = <A, E>(
	host: Host,
	drivers: ReadonlyArray<Sandbox.Driver>,
	prompts: string[],
	program: Effect.Effect<A, E, Services | Scope.Scope>,
) => {
	const open = immediateOpen();
	return Effect.runPromise(
		program.pipe(
			// Inside the scope, so a hung exchange still tears its sandboxes down before vitest gives up.
			Effect.timeout("9 minutes"),
			Effect.scoped,
			Effect.provide(
				Harness.layer({
					database: ":memory:",
					home: path.join(host.root, "home"),
					hostCwd: path.join(host.root, "cwd"),
					sandboxes: drivers,
					llm: (request, signal) => {
						prompts.push(request.context.systemPrompt ?? "");
						return open(request, signal);
					},
				}),
			),
		),
	);
};

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

/** The prompts' `<project_context>`s, each sandbox base spelled by its label. */
const shown = async (prompts: ReadonlyArray<string>, bases: ReadonlyArray<readonly [string, string]>) => {
	let text = prompts.map((prompt) => context(prompt) ?? "").join("\n\n");
	for (const [base, label] of bases) {
		// The host sandbox's base is a host path that may be reached through a symlink.
		const real = await fs.realpath(base).catch(() => base);
		text = text.replaceAll(real, label).replaceAll(base, label);
	}
	return text;
};

const worktreeRepo = Effect.gen(function* () {
	const { cwd } = yield* SandboxIO.Current;
	const files = yield* SandboxIO.FileSystem;
	const shell = yield* SandboxIO.Shell;
	const base = path.posix.join(cwd, `instruction-e2e-${Date.now()}`);
	const repo = path.posix.join(base, "repo");
	yield* files.writeFile(path.posix.join(repo, "AGENTS.md"), "Main checkout copy.\n");
	yield* files.writeFile(path.posix.join(repo, "pkg", "AGENTS.override.md"), "Pkg: run vp check.\n");
	yield* files.writeFile(path.posix.join(repo, "pkg", "CLAUDE.md"), "Pkg (overridden): never shown.\n");
	const git = [
		"git init -q -b main",
		"git add -A",
		"git -c user.email=e2e@codework.sh -c user.name=e2e -c commit.gpgsign=false commit -q -m init",
		"git worktree add -q --detach .claude/worktrees/x",
	].join(" && ");
	const result = yield* shell.exec(git, { cwd: repo });
	if (result.exitCode !== 0) return yield* Effect.die(`git setup failed: ${result.stderr}`);
	const worktree = path.posix.join(repo, ".claude", "worktrees", "x");
	yield* files.writeFile(path.posix.join(worktree, "AGENTS.md"), "Worktree copy.\n");
	return { base, repo, worktree };
});

/**
 * Main checkout, nested worktree, then the main session relinked to a host directory whose settings
 * turn the plugin off. Every target shares one artifact, so a remote sandbox that diverges from the
 * host sandbox fails here.
 */
export const scenario = (target: Target) => () =>
	withHost(async (host) => {
		const prompts: string[] = [];
		const base = await run(
			host,
			target.drivers ?? [],
			prompts,
			Effect.gen(function* () {
				const controller = yield* SandboxController.Controller;
				const sandbox = target.provision === undefined ? undefined : yield* provisioned(target.provision);
				const mount = sandbox === undefined ? { cwd: host.sandbox } : {};
				const { base, repo, worktree } = yield* controller.withMount(sandbox?.id, worktreeRepo, mount);
				const on = sandbox === undefined ? {} : { sandbox };

				const main = yield* Session.create({
					...on,
					directory: path.posix.join(repo, "pkg"),
					hostDir: host.anchor,
				});
				yield* main.run("hello");
				const nested = yield* Session.create({
					...on,
					directory: path.posix.join(worktree, "pkg"),
					hostDir: host.anchor,
				});
				yield* nested.run("hello");
				// Settings follow the host directory link; files never do.
				const linked = yield* Session.link({ sessionId: main.id, hostDir: host.off });
				yield* linked.run("again");
				return base;
			}),
		);

		expect(prompts).toHaveLength(3);
		for (const prompt of prompts) expect(prompt).not.toContain("never shown");
		expect(context(prompts[1] ?? "")).not.toContain("Main checkout copy.");
		expect(context(prompts[2] ?? "")).toBeUndefined();
		await expect(await shown(prompts.slice(0, 2), [[base, "<sandbox>"]])).toMatchFileSnapshot(
			"./__artifacts__/prompt.instruction.e2e.txt",
		);
	});

const labelled = (label: string) =>
	Effect.gen(function* () {
		const { cwd } = yield* SandboxIO.Current;
		const files = yield* SandboxIO.FileSystem;
		const base = path.posix.join(cwd, `instruction-relink-${Date.now()}`);
		const repo = path.posix.join(base, "repo");
		yield* files.writeFile(path.posix.join(repo, "AGENTS.md"), `${label}: repo root.\n`);
		yield* files.writeFile(path.posix.join(repo, "pkg", "AGENTS.md"), `${label}: pkg.\n`);
		// A relink only moves between checkouts of one project, which the shared origin makes them.
		const shell = yield* SandboxIO.Shell;
		const git = "git init -q -b main && git remote add origin https://github.com/codeworksh/instruction-e2e";
		const result = yield* shell.exec(git, { cwd: repo });
		if (result.exitCode !== 0) return yield* Effect.die(`git setup failed: ${result.stderr}`);
		return { base, repo };
	});

/**
 * One session moved Daytona → Vercel → host sandbox. Each exchange must read only the sandbox the
 * session is on at that moment, at the same position under the new root.
 */
export const relinkScenario = (drivers: ReadonlyArray<Sandbox.Driver>) => () =>
	withHost(async (host) => {
		const prompts: string[] = [];
		const bases = await run(
			host,
			drivers,
			prompts,
			Effect.gen(function* () {
				const controller = yield* SandboxController.Controller;
				const daytona = yield* provisioned(
					Sandbox.create({ driver: "daytona", config: { language: "typescript" } }),
				);
				const vercel = yield* provisioned(
					Sandbox.create({ driver: "vercel", config: { runtime: "node24", timeout: 15 * 60 * 1000 } }),
				);
				const onDaytona = yield* controller.withMount(daytona.id, labelled("Daytona"));
				const onVercel = yield* controller.withMount(vercel.id, labelled("Vercel"));
				const onHost = yield* controller.withMount(undefined, labelled("Host"), { cwd: host.sandbox });

				const session = yield* Session.create({
					sandbox: daytona,
					directory: path.posix.join(onDaytona.repo, "pkg"),
					hostDir: host.anchor,
				});
				yield* session.run("on daytona");
				const toVercel = yield* Session.relink({
					sessionId: session.id,
					sandbox: vercel,
					directory: onVercel.repo,
				});
				expect((yield* toVercel.info).directory).toBe(path.posix.join(onVercel.repo, "pkg"));
				yield* toVercel.run("on vercel");
				const toHost = yield* Session.relink({ sessionId: session.id, directory: onHost.repo });
				yield* toHost.run("on host");
				return [
					[onDaytona.base, "<daytona>"],
					[onVercel.base, "<vercel>"],
					[onHost.base, "<host>"],
				] as const;
			}),
		);

		expect(prompts).toHaveLength(3);
		const labels = ["Daytona", "Vercel", "Host"];
		prompts.forEach((prompt, index) => {
			expect(prompt).not.toContain("never shown");
			for (const label of labels) {
				if (label === labels[index]) expect(prompt).toContain(`${label}: pkg.`);
				else expect(prompt).not.toContain(`${label}:`);
			}
		});
		await expect(await shown(prompts, bases)).toMatchFileSnapshot("./__artifacts__/prompt.instruction.relink.txt");
	});

const FIXTURE = { remote: "https://github.com/codeworksh/69th", branch: "fixture/instruction-files" };
/** The branch is mutable; a clone at any other commit would make the artifact lie. */
const PINNED = "6b47f8aa0d88847512773f6b33e188d847825f6a";

const clone = Effect.gen(function* () {
	const { cwd } = yield* SandboxIO.Current;
	const target = path.posix.join(cwd, `69th-${Date.now()}`);
	const result = yield* Git.Service.use((git) => git.clone({ ...FIXTURE, target, depth: 1 })).pipe(
		Effect.provide(Git.layer),
	);
	if (result.exitCode !== 0) return yield* Effect.die(`clone failed: ${result.stderr || result.text}`);
	const head = yield* SandboxIO.Shell.use((shell) => shell.exec("git rev-parse HEAD", { cwd: target }));
	if (head.stdout.trim() !== PINNED)
		return yield* Effect.die(`${FIXTURE.branch} moved to ${head.stdout.trim()}; expected ${PINNED}`);
	return target;
});

/**
 * The real `codeworksh/69th` fixture branch, cloned into Daytona, Vercel and the host sandbox. One
 * session moves between the three checkouts at `packages/api/src`; `packages/web` and `docs` get a
 * session in each. A directory renders the same context in every sandbox.
 */
export const repositoryScenario = (drivers: ReadonlyArray<Sandbox.Driver>) => () =>
	withHost(async (host) => {
		const prompts: string[] = [];
		const directories = ["packages/api/src", "packages/web", "docs"] as const;
		const checkouts = await run(
			host,
			drivers,
			prompts,
			Effect.gen(function* () {
				const controller = yield* SandboxController.Controller;
				const daytona = yield* provisioned(
					Sandbox.create({ driver: "daytona", config: { language: "typescript" } }),
				);
				const vercel = yield* provisioned(
					Sandbox.create({ driver: "vercel", config: { runtime: "node24", timeout: 15 * 60 * 1000 } }),
				);
				const targets = [
					{ sandbox: daytona, root: yield* controller.withMount(daytona.id, clone) },
					{ sandbox: vercel, root: yield* controller.withMount(vercel.id, clone) },
					{ sandbox: undefined, root: yield* controller.withMount(undefined, clone, { cwd: host.sandbox }) },
				];

				const [first, ...rest] = targets;
				if (first === undefined) return yield* Effect.die("no targets");
				const moving = yield* Session.create({
					sandbox: daytona,
					directory: path.posix.join(first.root, directories[0]),
					hostDir: host.anchor,
				});
				yield* moving.run("api");
				for (const target of rest) {
					const moved = yield* Session.relink({
						sessionId: moving.id,
						...(target.sandbox === undefined ? {} : { sandbox: target.sandbox }),
						directory: target.root,
					});
					expect((yield* moved.info).directory.endsWith(`/${directories[0]}`)).toBe(true);
					yield* moved.run("api");
				}
				for (const directory of directories.slice(1))
					for (const target of targets) {
						const session = yield* Session.create({
							...(target.sandbox === undefined ? {} : { sandbox: target.sandbox }),
							directory: path.posix.join(target.root, directory),
							hostDir: host.anchor,
						});
						yield* session.run(directory);
					}
				return targets.map((target) => target.root);
			}),
		);

		// Three api exchanges (one per relink), then web and docs on every checkout.
		expect(prompts).toHaveLength(9);
		for (const prompt of prompts) expect(prompt).not.toContain("never shown");
		const rendered = await Promise.all(
			prompts.map((prompt, index) => shown([prompt], [[checkouts[index % 3] ?? "", "<checkout>"]])),
		);
		const byDirectory = directories.map((_, group) => rendered.slice(group * 3, group * 3 + 3));
		for (const sandboxes of byDirectory) {
			expect(sandboxes[1]).toBe(sandboxes[0]);
			expect(sandboxes[2]).toBe(sandboxes[0]);
		}
		await expect(byDirectory.map((sandboxes) => sandboxes[0]).join("\n\n")).toMatchFileSnapshot(
			"./__artifacts__/prompt.instruction.69th.txt",
		);
	});
