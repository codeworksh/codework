import "./utils/env.ts";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
	exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd }).then(() => undefined);

const write = async (path: string, text: string) => {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text);
};

const prompt = async (input: { root: string; directory: string; hostCwd: string }) => {
	const observed: string[] = [];
	const open = immediateOpen();
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
		),
	);
	const real = await realpath(input.root);
	return (observed[0] ?? "").replaceAll(real, "<root>").replaceAll(input.root, "<root>");
};

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
});
