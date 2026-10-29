import "./utils/env.ts";
import { Effect, Logger, Schema } from "effect";
import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Location } from "../src/location/location.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { discover, skillPlugin } from "../src/plugin/builtin/prompt/skill.ts";
import { bashPlugin } from "../src/plugin/builtin/tool/bash.ts";
import { readPlugin } from "../src/plugin/builtin/tool/read.ts";
import { define } from "../src/plugin/index.ts";
import { ProjectSchema } from "../src/project/schema.ts";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import * as Tool from "../src/tool/tool.ts";
import { SpaceSchema } from "../src/space/schema.ts";
import { Space } from "../src/space/space.ts";
import { immediateOpen, toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { scenario } from "./fixtures/skill.spec.ts";
import { pendingCall } from "./tools.fixture.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
	exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd }).then(() => undefined);

const write = async (path: string, text: string) => {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text);
};

/** Runs one exchange; `warnings` collects every warning the harness logged while it ran. */
const prompt = async (input: {
	root: string;
	directory: string;
	hostCwd: string;
	warnings?: string[];
	plugins?: NonNullable<Parameters<typeof Harness.layer>[0]>["plugins"];
}) => {
	const observed: string[] = [];
	const open = immediateOpen();
	const collector = Logger.make(({ logLevel, message }) => {
		if (logLevel === "Warn") input.warnings?.push((Array.isArray(message) ? message : [message]).join(" "));
	});
	await Effect.runPromise(
		Effect.gen(function* () {
			const { main: session } = yield* Session.create({ directory: input.directory });
			yield* session.run("hello");
		}).pipe(
			Effect.provide(
				Harness.layer({
					home: join(input.root, "home"),
					hostCwd: input.hostCwd,
					database: ":memory:",
					...(input.plugins === undefined ? {} : { plugins: input.plugins }),
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

const skillsSection = (text: string) => /<skills>\n[\s\S]*?\n<\/skills>/.exec(text)?.[0];

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

describe("codework.prompt.skill", () => {
	it("reads .codework/skills at the cwd and .agents/skills up to the sandbox root outside a repo, enforces validation/ignore/collision rules, and ignores host paths", () =>
		withSettings(async ({ root }) => {
			// Host-only paths that must never be consulted:
			await write(
				join(root, "home", "skills", "home-skill", "SKILL.md"),
				"---\nname: home-skill\ndescription: Never shown from host home.\n---\n",
			);
			await write(
				join(root, "elsewhere", ".codework", "skills", "host-skill", "SKILL.md"),
				"---\nname: host-skill\ndescription: Never shown from hostCwd.\n---\n",
			);

			// Ancestor (repo) skills:
			await write(
				join(root, "repo", ".agents", "skills", "README.md"),
				"---\nname: ignored-root-readme\ndescription: Root markdown in .agents/skills is ignored.\n---\n",
			);
			await write(
				join(root, "repo", ".agents", "skills", "repo-agent", "SKILL.md"),
				'---\nname: repo-agent\ndescription: |\n  Multiline repo skill\n  with <xml> & "quotes".\n---\n',
			);
			await write(
				join(root, "repo", ".agents", "skills", "third-party", "standalone-agent.md"),
				"---\nname: standalone-agent\ndescription: Nested markdown skill in .agents/skills.\n---\n",
			);
			await write(
				join(root, "repo", ".agents", "skills", "shared-skill", "SKILL.md"),
				"---\nname: shared-skill\ndescription: Repo copy (loses collision to pkg).\n---\n",
			);
			// .codework/skills is read at the cwd only:
			await write(
				join(root, "repo", ".codework", "skills", "outer-skill", "SKILL.md"),
				"---\nname: outer-skill\ndescription: Never shown from .codework/skills above the cwd.\n---\n",
			);

			// Symlinked duplicate skill directory (deduped silently via realpath):
			await mkdir(join(root, "repo", "pkg", ".agents", "skills"), { recursive: true });
			await symlink(
				join(root, "repo", ".agents", "skills", "repo-agent"),
				join(root, "repo", "pkg", ".agents", "skills", "repo-agent-link"),
			);

			// Closest directory (repo/pkg) skills:
			await write(join(root, "repo", "pkg", ".codework", "skills", ".gitignore"), "venv\nignored.md\n");
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "venv", "bad-skill", "SKILL.md"),
				"---\nname: bad-skill\ndescription: Ignored by .gitignore.\n---\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "ignored.md"),
				"---\nname: ignored-md\ndescription: Ignored root markdown.\n---\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "root-note.md"),
				"# Just a markdown note without description (silently skipped)\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "root-skill.md"),
				"\uFEFF---\nname: root-skill\ndescription: Standalone root markdown skill in .codework/skills.\n---\n",
			);
			// Skill root stops recursion into nested SKILL.md:
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "shared-skill", "SKILL.md"),
				"---\ndescription: Pkg copy wins collision and derives name from parent dir.\n---\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "shared-skill", "nested-ignored", "SKILL.md"),
				"---\nname: nested-ignored\ndescription: Never reached under a skill root.\n---\n",
			);
			// Hidden from model invocation:
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "manual-only", "SKILL.md"),
				"---\nname: manual-only\ndescription: Hidden from prompt.\ndisable-model-invocation: true\n---\n",
			);
			// Validation warnings (invalid name characters + consecutive hyphens, long name, long description, unknown field, missing description skipped, invalid YAML skipped):
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "warn-skill", "SKILL.md"),
				"---\nname: Bad--Name_Here\ndescription: Loads despite name warnings.\n---\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "long-name", "SKILL.md"),
				`---\nname: ${"a".repeat(65)}\ndescription: Loads despite 65-char name.\n---\n`,
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "long-desc", "SKILL.md"),
				`---\nname: long-desc\ndescription: ${"x".repeat(1025)}\n---\n`,
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "unknown-field", "SKILL.md"),
				"---\nname: unknown-field\ndescription: Ignores unknown frontmatter fields.\ncustom-field: ignored\n---\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "missing-desc", "SKILL.md"),
				"---\nname: missing-desc\n---\nNo description.\n",
			);
			await write(
				join(root, "repo", "pkg", ".codework", "skills", "broken-yaml", "SKILL.md"),
				"---\nname: [unclosed\ndescription: broken\n---\n",
			);

			const warnings: string[] = [];
			const text = await prompt({
				root,
				directory: join(root, "repo", "pkg"),
				hostCwd: join(root, "elsewhere"),
				warnings,
			});
			const real = await realpath(root);
			const normalisedWarnings = warnings
				.map((line) => line.replaceAll(real, "<root>").replaceAll(root, "<root>").split("\n")[0] ?? "")
				.sort();

			expect(text).not.toContain("Never shown");
			expect(text).not.toContain("ignored-root-readme");
			expect(text).not.toContain("bad-skill");
			expect(text).not.toContain("ignored-md");
			expect(text).not.toContain("nested-ignored");
			expect(text).not.toContain("manual-only");
			expect(text).not.toContain("missing-desc");
			expect(text).not.toContain("broken-yaml");

			await expect([skillsSection(text), ...normalisedWarnings].join("\n\n")).toMatchFileSnapshot(
				"./__artifacts__/prompt.skill.txt",
			);
		}));

	it("stops the .agents/skills walk at the git root, so a nested worktree never sees the main checkout's skills", () =>
		withSettings(async ({ root }) => {
			const repo = join(root, "repo");
			await mkdir(repo, { recursive: true });
			await git(repo, "init", "-q", "-b", "main");
			await git(repo, "config", "user.email", "test@codework.sh");
			await git(repo, "config", "user.name", "Codework Test");
			await write(
				join(repo, ".agents", "skills", "deploy", "SKILL.md"),
				"---\nname: deploy\ndescription: Main checkout deploy skill.\n---\n",
			);
			await git(repo, "add", ".");
			await git(repo, "commit", "-q", "-m", "init");

			await write(
				join(root, ".agents", "skills", "outside", "SKILL.md"),
				"---\nname: outside\ndescription: Above the git root.\n---\n",
			);

			const worktree = join(repo, ".claude", "worktrees", "x");
			await git(repo, "worktree", "add", "-q", "--detach", worktree);
			await write(
				join(worktree, ".agents", "skills", "deploy", "SKILL.md"),
				"---\nname: deploy\ndescription: Worktree deploy skill.\n---\n",
			);

			const warnings: string[] = [];
			const text = skillsSection(await prompt({ root, directory: worktree, hostCwd: root, warnings })) ?? "";
			expect(text).toContain("<location><root>/repo/.claude/worktrees/x/.agents/skills/deploy/SKILL.md</location>");
			expect(text).toContain("<description>Worktree deploy skill.</description>");
			expect(text).not.toContain("Main checkout deploy skill.");
			expect(text).not.toContain("Above the git root.");
			expect(warnings).toEqual([]);
		}));

	it("adapts the reader hint to visible tools, hidden tools, and omits <skills> when no reader exists", () =>
		withSettings(async ({ root }) => {
			const dir = join(root, "repo");
			await write(
				join(dir, ".codework", "skills", "pdf", "SKILL.md"),
				"---\nname: pdf\ndescription: Read PDFs.\n---\n",
			);

			// 1. Default (read + bash): names the read tool
			const withRead = skillsSection(await prompt({ root, directory: dir, hostCwd: root })) ?? "";
			expect(withRead).toContain("Use the read tool to load a skill's file when the task matches its description.");

			// 2. Only bash enabled: names bash
			const withBash =
				skillsSection(
					await prompt({
						root,
						directory: dir,
						hostCwd: root,
						plugins: [bashPlugin, defaultPromptPlugin, skillPlugin],
					}),
				) ?? "";
			expect(withBash).toContain("Use bash to load a skill's file when the task matches its description.");

			// 3. Reader tool hidden from <tools> (empty promptSnippet): indirect hint naming no tool
			const hideRead = define({
				id: "acme.tool.hide-read",
				kind: "tool",
				setup: (ctx) => {
					ctx.plugin.tools.update("read", { promptSnippet: "" });
				},
			});
			const withHiddenRead =
				skillsSection(
					await prompt({
						root,
						directory: dir,
						hostCwd: root,
						plugins: [readPlugin, hideRead, defaultPromptPlugin, skillPlugin],
					}),
				) ?? "";
			expect(withHiddenRead).toContain("Load a skill's file when the task matches its description.");
			expect(withHiddenRead).not.toContain("Use the read tool");

			// 4. No reader tool at all: <skills> omitted
			const withNoReader = skillsSection(
				await prompt({
					root,
					directory: dir,
					hostCwd: root,
					plugins: [defaultPromptPlugin, skillPlugin],
				}),
			);
			expect(withNoReader).toBeUndefined();
		}));

	it("names only a reader declared to the model, and omits <skills> when every reader is undeclared", () =>
		withSettings(async ({ root }) => {
			const dir = join(root, "repo");
			await write(
				join(dir, ".agents", "skills", "daytona", "SKILL.md"),
				"---\nname: daytona\ndescription: Creates and manages isolated cloud sandboxes on the Daytona platform.\n---\n",
			);
			await write(
				join(dir, ".agents", "skills", "break-ui", "SKILL.md"),
				"---\nname: break-ui\ndescription: Stress-test a piece of UI with worst-case data.\n---\n",
			);
			// Re-registering a built-in reader under the same name overrides its exposure.
			const expose = (exposures: Readonly<Record<string, Tool.ToolExposure>>) =>
				define({
					id: "acme.tool.expose",
					kind: "tool",
					setup: (ctx) => {
						for (const [name, exposure] of Object.entries(exposures)) {
							ctx.plugin.tools.add(
								Tool.register(
									Tool.make({
										name,
										description: `${name} tool`,
										promptSnippet: `${name} snippet`,
										exposure,
										parameters: Schema.Struct({}),
										success: Schema.String,
										handler: () => Effect.succeed(""),
									}),
								),
							);
						}
					},
				});
			const run = async (exposures: Readonly<Record<string, Tool.ToolExposure>>) =>
				skillsSection(
					await prompt({
						root,
						directory: dir,
						hostCwd: root,
						plugins: [readPlugin, bashPlugin, expose(exposures), defaultPromptPlugin, skillPlugin],
					}),
				) ?? null;

			const cases = {
				"read hidden": await run({ read: "hidden" }),
				"read deferred, bash codemode": await run({ read: "deferred", bash: "codemode" }),
				"read model": await run({ read: "model" }),
			};
			expect(cases["read hidden"]).toContain("Use bash to load a skill's file");
			expect(cases["read deferred, bash codemode"]).toBeNull();
			expect(cases["read model"]).toContain("Use the read tool to load a skill's file");
			await expect(`${JSON.stringify(cases, null, "\t")}\n`).toMatchFileSnapshot(
				"./__artifacts__/prompt.skill.exposure.json",
			);
		}));

	it("lazily loads full SKILL.md instructions only when the model reads the advertised location", () =>
		withSettings(async ({ root }) => {
			const dir = join(root, "repo");
			const skillPath = join(dir, ".codework", "skills", "pdf-tools", "SKILL.md");
			await write(
				skillPath,
				"---\nname: pdf-tools\ndescription: Extract text from PDFs.\n---\n\n# PDF Instructions\nRun `scripts/extract.sh` with `--full`.",
			);

			const open = toolTurn(pendingCall("read", { path: await realpath(skillPath) }));
			const requests: Array<{ systemPrompt: string; messages: unknown }> = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const { main: session } = yield* Session.create({ directory: dir });
					yield* session.run("extract report.pdf");
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: root,
							database: ":memory:",
							llm: (request, signal) => {
								requests.push({
									systemPrompt: request.context.systemPrompt ?? "",
									messages: request.context.messages,
								});
								return open(request, signal);
							},
						}),
					),
					Effect.scoped,
				),
			);

			expect(requests).toHaveLength(2);
			// Turn 1 system prompt only advertises name + description + location, never the body:
			expect(requests[0]?.systemPrompt).toContain("<name>pdf-tools</name>");
			expect(requests[0]?.systemPrompt).toContain("<description>Extract text from PDFs.</description>");
			expect(requests[0]?.systemPrompt).not.toContain("# PDF Instructions");
			expect(requests[0]?.systemPrompt).not.toContain("scripts/extract.sh");
			// Turn 2 receives the full SKILL.md body from the read tool call:
			expect(JSON.stringify(requests[1]?.messages)).toContain("# PDF Instructions");
			expect(JSON.stringify(requests[1]?.messages)).toContain("scripts/extract.sh");
		}));

	it("adds nothing when codework.prompt.skill is disabled in settings", () =>
		withSettings(async ({ root }) => {
			const dir = join(root, "repo");
			await write(
				join(dir, ".codework", "skills", "pdf", "SKILL.md"),
				"---\nname: pdf\ndescription: Read PDFs.\n---\n",
			);
			await write(
				join(root, "home", "settings.jsonc"),
				JSON.stringify({ plugins: [{ plugin: "codework.prompt.skill", enabled: false }] }),
			);

			const text = await prompt({ root, directory: dir, hostCwd: root });
			expect(text).toContain("<cwd>");
			expect(skillsSection(text)).toBeUndefined();
		}));

	it("probes the cwd's .codework/skills and every ancestor's .agents/skills and .git in one batch, logging non-ENOENT errors", async () => {
		const stats = { paths: [] as string[], inFlight: 0, peak: 0 };
		const unused = () => Promise.reject(new Error("unused"));
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
		const fs = SandboxFileSystem.fromProvider({
			readFile: unused,
			readFileBuffer: unused,
			readBytes: unused,
			writeFile: unused,
			stat: unused,
			readdir: unused,
			exists: async (path) => {
				stats.paths.push(path);
				stats.peak = Math.max(stats.peak, ++stats.inFlight);
				await settle();
				stats.inFlight -= 1;
				if (path === "/a/b/.agents/skills") {
					throw Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: "EIO" });
				}
				return false;
			},
			mkdir: unused,
			rm: unused,
			realpath: unused,
			scanLines: unused,
		});

		const warnings: string[] = [];
		const collector = Logger.make(({ logLevel, message }) => {
			if (logLevel === "Warn") warnings.push((Array.isArray(message) ? message : [message]).join(" "));
		});
		const found = await Effect.runPromise(
			discover(fs, plain("/a/b/c")).pipe(Effect.provide(Logger.layer([collector]))),
		);

		expect(stats.paths.sort()).toEqual([
			"/.agents/skills",
			"/.git",
			"/a/.agents/skills",
			"/a/.git",
			"/a/b/.agents/skills",
			"/a/b/.git",
			"/a/b/c/.agents/skills",
			"/a/b/c/.codework/skills",
			"/a/b/c/.git",
		]);
		expect(stats.peak).toBe(9);
		expect(found).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not stat skill directory /a/b/.agents/skills");
	});

	it(
		"reads only the host sandbox's cwd walk, honours the nested worktree and the host dir link",
		scenario({}),
		60_000,
	);
});
