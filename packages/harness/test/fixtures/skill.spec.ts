import { Effect, type Layer, type Scope } from "effect";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vite-plus/test";
import { Harness } from "../../src/effect/harness.ts";
import { Sandbox } from "../../src/effect/sandbox.ts";
import { Session } from "../../src/effect/session.ts";
import { SandboxController } from "../../src/sandbox/control.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { immediateOpen } from "./llm.ts";

const skills = (text: string) => /<skills>\n[\s\S]*?\n<\/skills>/.exec(text)?.[0];

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

/** Host-side directories whose skill files must never reach a prompt. */
const withHost = async (use: (host: Host) => Promise<void>) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codework-skill-e2e-"));
	const write = async (file: string, text: string) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
	};
	try {
		await write(
			path.join(root, "home", ".codework", "skills", "home-skill", "SKILL.md"),
			"---\nname: home-skill\ndescription: Home: never shown.\n---\n",
		);
		await write(
			path.join(root, "cwd", ".codework", "skills", "cwd-skill", "SKILL.md"),
			"---\nname: cwd-skill\ndescription: Host cwd: never shown.\n---\n",
		);
		await write(
			path.join(root, "anchor", ".codework", "skills", "anchor-skill", "SKILL.md"),
			"---\nname: anchor-skill\ndescription: Host dir: never shown.\n---\n",
		);
		await write(path.join(root, "anchor", ".codework", "settings.jsonc"), "{}");
		await write(
			path.join(root, "off", ".codework", "skills", "off-skill", "SKILL.md"),
			"---\nname: off-skill\ndescription: Host dir: never shown.\n---\n",
		);
		await write(
			path.join(root, "off", ".codework", "settings.jsonc"),
			JSON.stringify({ plugins: [{ plugin: "codework.prompt.skill", enabled: false }] }),
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

/** The prompts' `<skills>` sections, each sandbox base spelled by its label. */
const shown = async (prompts: ReadonlyArray<string>, bases: ReadonlyArray<readonly [string, string]>) => {
	let text = prompts.map((prompt) => skills(prompt) ?? "").join("\n\n");
	for (const [base, label] of bases) {
		const real = await fs.realpath(base).catch(() => base);
		text = text.replaceAll(real, label).replaceAll(base, label);
	}
	return text;
};

const worktreeRepo = Effect.gen(function* () {
	const { cwd } = yield* SandboxIO.Current;
	const files = yield* SandboxIO.FileSystem;
	const shell = yield* SandboxIO.Shell;
	const base = path.posix.join(cwd, `skill-e2e-${Date.now()}`);
	const repo = path.posix.join(base, "repo");
	yield* files.writeFile(
		path.posix.join(repo, ".agents", "skills", "deploy", "SKILL.md"),
		"---\nname: deploy\ndescription: Main checkout deploy.\n---\n",
	);
	// Above the git root and `.codework/skills` above the cwd: never read.
	yield* files.writeFile(
		path.posix.join(base, ".agents", "skills", "outside", "SKILL.md"),
		"---\nname: outside\ndescription: Above the git root: never shown.\n---\n",
	);
	yield* files.writeFile(
		path.posix.join(repo, ".codework", "skills", "repo-root", "SKILL.md"),
		"---\nname: repo-root\ndescription: Above the cwd: never shown.\n---\n",
	);
	yield* files.writeFile(
		path.posix.join(repo, "pkg", ".codework", "skills", "test-runner", "SKILL.md"),
		"---\nname: test-runner\ndescription: Run package tests with vp test.\n---\n",
	);
	yield* files.writeFile(
		path.posix.join(repo, "pkg", ".codework", "skills", "manual-only", "SKILL.md"),
		"---\nname: manual-only\ndescription: never shown\ndisable-model-invocation: true\n---\n",
	);
	const git = [
		"git init -q -b main",
		"git add -A",
		"git -c user.email=e2e@codework.sh -c user.name=e2e -c commit.gpgsign=false commit -q -m init",
		"git worktree add -q --detach .claude/worktrees/x",
	].join(" && ");
	const result = yield* shell.exec(git, { cwd: repo });
	if (result.exitCode !== 0) return yield* Effect.die(`git setup failed: ${result.stderr}`);
	const worktree = path.posix.join(repo, ".claude", "worktrees", "x");
	yield* files.writeFile(
		path.posix.join(worktree, ".agents", "skills", "deploy", "SKILL.md"),
		"---\nname: deploy\ndescription: Worktree deploy.\n---\n",
	);
	return { base, repo, worktree };
});

/**
 * Main checkout, nested worktree, then the main session relinked to a host directory whose settings
 * turn `codework.prompt.skill` off. Every target shares one artifact, so a remote sandbox that
 * diverges from the host sandbox fails here.
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
				yield* main.main.run("hello");
				const nested = yield* Session.create({
					...on,
					directory: path.posix.join(worktree, "pkg"),
					hostDir: host.anchor,
				});
				yield* nested.main.run("hello");
				// Settings follow the host directory link; skill files never do.
				const linked = yield* Session.link({ sessionId: main.id, hostDir: host.off });
				yield* linked.main.run("again");
				return base;
			}),
		);

		expect(prompts).toHaveLength(3);
		for (const prompt of prompts) expect(prompt).not.toContain("never shown");
		expect(skills(prompts[1] ?? "")).not.toContain("Main checkout deploy.");
		expect(skills(prompts[2] ?? "")).toBeUndefined();
		await expect(await shown(prompts.slice(0, 2), [[base, "<sandbox>"]])).toMatchFileSnapshot(
			"./__artifacts__/prompt.skill.e2e.txt",
		);
	});

const labelled = (label: string) =>
	Effect.gen(function* () {
		const { cwd } = yield* SandboxIO.Current;
		const files = yield* SandboxIO.FileSystem;
		const base = path.posix.join(cwd, `skill-relink-${Date.now()}`);
		const repo = path.posix.join(base, "repo");
		yield* files.writeFile(
			path.posix.join(repo, ".agents", "skills", "repo-skill", "SKILL.md"),
			`---\nname: repo-skill\ndescription: "${label}: repo root."\n---\n`,
		);
		yield* files.writeFile(
			path.posix.join(repo, "pkg", ".codework", "skills", "pkg-skill", "SKILL.md"),
			`---\nname: pkg-skill\ndescription: "${label}: pkg."\n---\n`,
		);
		const shell = yield* SandboxIO.Shell;
		const git = "git init -q -b main && git remote add origin https://github.com/codeworksh/skill-e2e";
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
				yield* session.main.run("on daytona");
				const toVercel = yield* Session.relink({
					sessionId: session.id,
					sandbox: vercel,
					directory: onVercel.repo,
				});
				expect((yield* toVercel.info).directory).toBe(path.posix.join(onVercel.repo, "pkg"));
				yield* toVercel.main.run("on vercel");
				const toHost = yield* Session.relink({ sessionId: session.id, directory: onHost.repo });
				yield* toHost.main.run("on host");
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
		await expect(await shown(prompts, bases)).toMatchFileSnapshot("./__artifacts__/prompt.skill.relink.txt");
	});
