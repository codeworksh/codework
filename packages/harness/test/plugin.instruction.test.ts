import "./utils/env.ts";
import { Effect, Logger } from "effect";
import { execFile } from "node:child_process";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Location } from "../src/location/location.ts";
import { discover } from "../src/plugin/builtin/prompt/instruction.ts";
import { ProjectSchema } from "../src/project/schema.ts";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SpaceSchema } from "../src/space/schema.ts";
import { Space } from "../src/space/space.ts";
import { scenario } from "./fixtures/instruction.spec.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
	exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd }).then(() => undefined);

const write = async (path: string, text: string) => {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text);
};

/** Runs one exchange; `warnings` collects every warning the harness logged while it ran. */
const prompt = async (input: { root: string; directory: string; hostCwd: string; warnings?: string[] }) => {
	const observed: string[] = [];
	const open = immediateOpen();
	const collector = Logger.make(({ logLevel, message }) => {
		if (logLevel === "Warn") input.warnings?.push((Array.isArray(message) ? message : [message]).join(" "));
	});
	await Effect.runPromise(
		Effect.gen(function* () {
			const session = yield* Session.create({ directory: input.directory });
			yield* session.run("hello");
		}).pipe(
			Effect.provide(
				Harness.layer({
					home: join(input.root, "home"),
					hostCwd: input.hostCwd,
					database: ":memory:",
					llm: (request, signal) => {
						observed.push(request.context.systemPrompt ?? "");
						return open(request, signal);
					},
				}),
			),
			Effect.scoped,
			Effect.provide(Logger.layer([collector])),
		),
	);
	const real = await realpath(input.root);
	return (observed[0] ?? "").replaceAll(real, "<root>").replaceAll(input.root, "<root>");
};

/**
 * A filesystem over `files`. Paths in `slow` answer `stat` and `readFile` late, so a probe that took
 * completion order for candidate order would be caught; `failing` paths fail `stat` with EIO.
 */
const instrumented = (
	files: Readonly<Record<string, string>>,
	slow: ReadonlySet<string>,
	failing: ReadonlySet<string>,
) => {
	const stats = { calls: 0, inFlight: 0, peak: 0 };
	const unused = () => Promise.reject(new Error("unused"));
	const settle = (path: string) => new Promise((resolve) => setTimeout(resolve, slow.has(path) ? 30 : 1));
	const fs = SandboxFileSystem.fromProvider({
		readFile: async (path) => {
			await settle(path);
			return path in files ? (files[path] ?? "") : unused();
		},
		readFileBuffer: unused,
		writeFile: unused,
		stat: async (path) => {
			stats.calls += 1;
			stats.peak = Math.max(stats.peak, ++stats.inFlight);
			await settle(path);
			stats.inFlight -= 1;
			if (failing.has(path)) throw Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: "EIO" });
			if (!(path in files)) throw Object.assign(new Error(`ENOENT: stat '${path}'`), { code: "ENOENT" });
			return { isFile: true, isDirectory: false };
		},
		readdir: unused,
		exists: unused,
		mkdir: unused,
		rm: unused,
		realpath: unused,
		scanLines: unused,
	});
	return { fs, stats };
};

const plain = (directory: string) =>
	new Location.Info({
		directory: AbsolutePath.make(directory),
		space: new SpaceSchema.Info({
			id: Space.id(SandboxInstance.ID.local, directory),
			projectId: ProjectSchema.ID.make("local"),
			location: AbsolutePath.make(directory),
			kind: "plain",
			env: SandboxInstance.ID.local,
			status: "active",
		}),
		project: new ProjectSchema.Info({ id: ProjectSchema.ID.make("local"), name: "local", status: "active" }),
	});

const context = (text: string) => /<project_context>\n[\s\S]*?\n<\/project_context>/.exec(text)?.[0];

describe("codework.prompt.instruction", () => {
	it("loads one file per directory from the sandbox root down to the cwd, and nothing from the host", () =>
		withSettings(async ({ root }) => {
			await write(join(root, "home", "AGENTS.md"), "Home: never shown.\n");
			await write(join(root, "repo", "AGENTS.md"), "Repo (overridden): never shown.\n");
			await write(join(root, "repo", "CLAUDE.override.md"), "Repo: use Effect for services.\n");
			await write(join(root, "repo", "pkg", "CLAUDE.md"), "Pkg (overridden): never shown.\n");
			await write(join(root, "repo", "pkg", "AGENTS.override.md"), "\uFEFFPkg: run vp check.\n");
			await write(join(root, "repo", "pkg", "app", "AGENTS.md"), "  \n");
			const locked = join(root, "repo", "pkg", "app", "src", "AGENTS.override.md");
			await write(locked, "Locked: never shown.\n");
			await chmod(locked, 0o000);
			await write(join(root, "repo", "pkg", "app", "src", "AGENTS.md"), "Src: closest to the cwd.\n");
			await write(join(root, "elsewhere", "AGENTS.md"), "Elsewhere: host directory, never shown.\n");

			const text = await prompt({
				root,
				directory: join(root, "repo", "pkg", "app", "src"),
				hostCwd: join(root, "elsewhere"),
			});
			await chmod(locked, 0o644);
			expect(text).not.toContain("never shown");
			expect(text).not.toContain("\uFEFF");
			await expect(context(text)).toMatchFileSnapshot("./__artifacts__/prompt.instruction.txt");
		}));

	it("keeps a nested worktree's file and drops the main checkout's copy", () =>
		withSettings(async ({ root }) => {
			const repo = join(root, "repo");
			await mkdir(repo, { recursive: true });
			await git(repo, "init", "-q", "-b", "main");
			await git(repo, "config", "user.email", "test@codework.sh");
			await git(repo, "config", "user.name", "Codework Test");
			await write(join(repo, "AGENTS.md"), "Main checkout copy.\n");
			await git(repo, "add", "AGENTS.md");
			await git(repo, "commit", "-q", "-m", "init");
			const worktree = join(repo, ".claude", "worktrees", "x");
			await git(repo, "worktree", "add", "-q", "--detach", worktree);
			await write(join(worktree, "AGENTS.md"), "Worktree copy.\n");

			const text = context(await prompt({ root, directory: worktree, hostCwd: root })) ?? "";
			expect(text).toContain('<project_instructions path="<root>/repo/.claude/worktrees/x/AGENTS.md">');
			expect(text).toContain("Worktree copy.");
			expect(text).not.toContain("Main checkout copy.");

			const main = context(await prompt({ root, directory: repo, hostCwd: root })) ?? "";
			expect(main).toContain("Main checkout copy.");
		}));

	it("logs a stat failure that is not absence and still uses the next candidate", () =>
		withSettings(async ({ root }) => {
			const src = join(root, "repo", "src");
			await write(join(root, "repo", "AGENTS.md"), "Repo.\n");
			await write(join(src, "AGENTS.md"), "Src: still loaded.\n");
			// A symlink to itself: `stat` fails with ELOOP, which is not "no such file".
			await symlink("AGENTS.override.md", join(src, "AGENTS.override.md"));

			const warnings: string[] = [];
			const text = await prompt({ root, directory: src, hostCwd: root, warnings });
			const real = await realpath(root);
			const normalised = warnings.map((line) => line.replaceAll(real, "<root>").replaceAll(root, "<root>"));
			expect(
				normalised.some((line) =>
					line.includes("could not stat instruction file <root>/repo/src/AGENTS.override.md"),
				),
			).toBe(true);
			await expect(
				[context(text), ...normalised.map((line) => line.split("\n")[0])].join("\n\n"),
			).toMatchFileSnapshot("./__artifacts__/prompt.instruction.unreadable.txt");
		}));

	it("probes every candidate of every ancestor in one batch and keeps candidate order", async () => {
		// The winners answer last: the root's file after the cwd's, `AGENTS.MD` after `CLAUDE.md`.
		const { fs, stats } = instrumented(
			{
				"/AGENTS.md": "root",
				"/a/b/CLAUDE.md": "b: lower priority",
				"/a/b/AGENTS.MD": "b: wins",
				"/a/b/c/d/e/f/AGENTS.md": "cwd",
			},
			new Set(["/AGENTS.md", "/a/b/AGENTS.MD"]),
			new Set(["/a/b/c/CLAUDE.override.md"]),
		);
		const warnings: string[] = [];
		const collector = Logger.make(({ logLevel, message }) => {
			if (logLevel === "Warn") warnings.push(String(message));
		});
		const found = await Effect.runPromise(
			discover(fs, plain("/a/b/c/d/e/f")).pipe(Effect.provide(Logger.layer([collector]))),
		);
		// Seven directories, six names each: all in flight at once instead of 42 serial round trips.
		expect(stats.calls).toBe(42);
		expect(stats.peak).toBe(42);
		expect(found.map((file) => `${file.path}=${file.content}`)).toEqual([
			"/AGENTS.md=root",
			"/a/b/AGENTS.MD=b: wins",
			"/a/b/c/d/e/f/AGENTS.md=cwd",
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not stat instruction file /a/b/c/CLAUDE.override.md");
	});

	it("adds nothing when it is disabled in settings", () =>
		withSettings(async ({ root }) => {
			await write(join(root, "repo", "AGENTS.md"), "Repo.\n");
			await write(
				join(root, "home", "settings.jsonc"),
				JSON.stringify({ plugins: [{ plugin: "codework.prompt.instruction", enabled: false }] }),
			);
			const text = await prompt({ root, directory: join(root, "repo"), hostCwd: root });
			expect(text).toContain("<cwd>");
			expect(context(text)).toBeUndefined();
		}));

	it(
		"reads only the host sandbox's cwd walk, honours the nested worktree and the host dir link",
		scenario({}),
		60_000,
	);
});
