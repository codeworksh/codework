import { Effect, Layer, Option } from "effect";
import { Buffer } from "node:buffer";
import { posix as path } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../../src/db/db";
import { Git } from "../../src/git/git";
import { ProjectCopy } from "../../src/project/copy";
import { Project } from "../../src/project/project";
import { SandboxEnv } from "../../src/sandbox/env";
import { SandboxFileSystem } from "../../src/sandbox/filesystem/filesystem";
import { Sandbox } from "../../src/sandbox/sandbox";
import { type ISandboxExe, Shell } from "../../src/sandbox/shell";
import { AbsolutePath } from "../../src/schema";
import { Session } from "../../src/session/session";
import { Hash } from "../../src/util/hash";

type Run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>) => Promise<A>;
type Resolve = <A, E>(envId: string, program: Effect.Effect<A, E, Sandbox.Provides>) => Promise<A>;

export interface RemoteSandboxSpecOptions {
	readonly kind: "vercel" | "daytona";
	readonly cwd: string;
	readonly inheritedEnv: {
		readonly key: string;
		readonly value: string;
	};
	readonly run: Run;
	readonly resolve: Resolve;
	readonly timeout: number;
	readonly githubPat?: string;
}

const name = (kind: string, purpose: string) => `cw-${kind}-${purpose}-${Date.now()}`;
const remote = "https://github.com/codeworksh/69th";

const githubAuth = (pat: string): Record<string, string> => ({
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
	GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`codeworksh:${pat}`).toString("base64")}`,
	GIT_TERMINAL_PROMPT: "0",
});

const prepareRepository = (input: {
	readonly kind: RemoteSandboxSpecOptions["kind"];
	readonly repo: string;
	readonly envId: string;
	readonly fs: SandboxFileSystem.Interface;
	readonly shell: ISandboxExe;
}) =>
	Effect.gen(function* () {
		const clone = yield* Effect.gen(function* () {
			const git = yield* Git.Service;
			return yield* git.clone({ remote, target: input.repo, branch: "main", depth: 1 });
		}).pipe(Effect.provide(Git.layer));
		if (clone.exitCode !== 0) {
			throw new Error(`unable to clone ${remote}: ${clone.stderr || clone.text}`);
		}

		const commitFile = `sandbox-${input.kind}.txt`;
		yield* input.fs.writeFile(path.join(input.repo, commitFile), `${input.envId}\n`);

		const git = (args: string[]) => input.shell.execArgv(["git", "-C", input.repo, ...args]);
		const commands = [
			yield* git(["config", "user.name", "Codework Sandbox Test"]),
			yield* git(["config", "user.email", "sandbox-test@codework.sh"]),
			yield* git(["add", "--", commitFile]),
			yield* git(["commit", "-m", `test: ${input.kind} sandbox IO`]),
		];
		const failed = commands.find((result) => result.exitCode !== 0);
		if (failed !== undefined) {
			throw new Error(`unable to commit in cloned repository: ${failed.stderr || failed.stdout}`);
		}

		return {
			head: yield* git(["rev-parse", "HEAD"]),
			originHead: yield* git(["rev-parse", "origin/main"]),
			ahead: yield* git(["rev-list", "--count", "origin/main..HEAD"]),
			branch: yield* git(["branch", "--show-current"]),
			origin: yield* git(["remote", "get-url", "origin"]),
			status: yield* git(["status", "--porcelain"]),
			subject: yield* git(["log", "-1", "--pretty=%s"]),
		};
	});

/**
 * Live contract shared by remote providers. The provider test owns one sandbox
 * and supplies two runners: direct access to that sandbox and reattachment by
 * its persisted environment id through SandboxMap.
 */
export const remoteSandboxSpec = (options: RemoteSandboxSpecOptions) => {
	describe("pluggable runtime contract", () => {
		it(
			"implements the complete filesystem surface",
			async () => {
				const root = path.join(options.cwd, name(options.kind, "fs"));
				const result = await options.run(
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const textFile = path.join(root, "nested", "text.txt");
						const binaryFile = path.join(root, "binary.dat");
						const hiddenFile = path.join(root, ".hidden");
						const link = path.join(root, "link.txt");

						const program = Effect.gen(function* () {
							// writeFile must create missing parents on every backend.
							yield* fs.writeFile(textFile, "remote text");
							yield* fs.writeFile(binaryFile, new Uint8Array([0, 1, 127, 128, 255]));
							yield* fs.writeFile(hiddenFile, "hidden");
							yield* fs.mkdir(path.join(root, "tree", "deep"), { recursive: true });

							const linked = yield* shell.execArgv(["ln", "-s", textFile, link]);
							const linkStat = yield* fs.stat(link);
							const linkLstat = fs.lstat === undefined ? undefined : yield* fs.lstat(link);

							const beforeRemove = {
								text: yield* fs.readFile(textFile),
								bytes: Array.from(yield* fs.readFileBuffer(binaryFile)),
								file: yield* fs.stat(textFile),
								directory: yield* fs.stat(path.join(root, "nested")),
								entries: [...(yield* fs.readdir(root))].sort(),
								present: yield* fs.exists(textFile),
								missing: yield* fs.exists(path.join(root, "missing")),
							};

							yield* fs.rm(path.join(root, "tree"), { recursive: true });
							yield* fs.rm(path.join(root, "already-gone"), { force: true });

							return {
								beforeRemove,
								linked,
								linkStat,
								linkLstat,
								treeRemoved: !(yield* fs.exists(path.join(root, "tree"))),
							};
						});

						return yield* program.pipe(
							Effect.ensuring(fs.rm(root, { recursive: true, force: true }).pipe(Effect.ignore)),
						);
					}),
				);

				expect(result.beforeRemove.text).toBe("remote text");
				expect(result.beforeRemove.bytes).toEqual([0, 1, 127, 128, 255]);
				expect(result.beforeRemove.file.isFile).toBe(true);
				expect(result.beforeRemove.directory.isDirectory).toBe(true);
				expect(result.beforeRemove.entries).toEqual([".hidden", "binary.dat", "link.txt", "nested", "tree"]);
				expect(result.beforeRemove.present).toBe(true);
				expect(result.beforeRemove.missing).toBe(false);
				expect(result.linked.exitCode).toBe(0);
				expect(result.linkStat.isFile).toBe(true);
				if (result.linkLstat !== undefined) expect(result.linkLstat.isSymbolicLink).toBe(true);
				expect(result.treeRemoved).toBe(true);
			},
			options.timeout,
		);

		it(
			"implements shell strings, argv, environment, cwd, and filesystem sharing",
			async () => {
				const relativeRoot = name(options.kind, "shell");
				const root = path.join(options.cwd, relativeRoot);
				const result = await options.run(
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;

						const program = Effect.gen(function* () {
							yield* fs.mkdir(root, { recursive: true });
							yield* fs.writeFile(path.join(root, "from-fs.txt"), "filesystem");

							const fromFs = yield* shell.execArgv(["cat", path.join(root, "from-fs.txt")]);
							const literal = yield* shell.execArgv(["printf", "%s", "two words;$(echo pwned)"]);
							const inherited = yield* shell.execArgv(["printenv", options.inheritedEnv.key]);
							const overridden = yield* shell.execArgv(["printenv", options.inheritedEnv.key], {
								env: { [options.inheritedEnv.key]: "from-command" },
							});
							const pwd = yield* shell.execArgv(["pwd"], { cwd: relativeRoot });
							const wrote = yield* shell.exec(`printf 'shell' > ${path.join(root, "from-shell.txt")}`);
							const fromShell = yield* fs.readFile(path.join(root, "from-shell.txt"));
							const failed = yield* shell.exec("printf 'failed'; exit 7");
							const uname = yield* shell.execArgv(["uname", "-s"]);

							return { fromFs, literal, inherited, overridden, pwd, wrote, fromShell, failed, uname };
						});

						return yield* program.pipe(
							Effect.ensuring(fs.rm(root, { recursive: true, force: true }).pipe(Effect.ignore)),
						);
					}),
				);

				expect(result.fromFs.stdout).toBe("filesystem");
				expect(result.literal.stdout).toBe("two words;$(echo pwned)");
				expect(result.inherited.stdout.trim()).toBe(options.inheritedEnv.value);
				expect(result.overridden.stdout.trim()).toBe("from-command");
				expect(result.pwd.stdout.trim()).toBe(root);
				expect(result.wrote.exitCode).toBe(0);
				expect(result.fromShell).toBe("shell");
				expect(result.failed.exitCode).toBe(7);
				expect(`${result.failed.stdout}${result.failed.stderr}`).toContain("failed");
				expect(result.uname.stdout.trim()).toBe("Linux");
			},
			options.timeout,
		);

		it(
			"clones and commits through SandboxMap, then persists the project and session namespace",
			async () => {
				const marker = path.join(options.cwd, name(options.kind, "mapped"), "marker.txt");
				const envId = await options.run(
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(marker, "reattached");
						return yield* SandboxEnv.EnvId;
					}),
				);

				const address = SandboxEnv.parse(envId);
				expect(address?.kind).toBe(options.kind);
				expect(address && SandboxEnv.format(address)).toBe(envId);

				const mapped = await options.resolve(
					envId,
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const mappedEnvId = yield* SandboxEnv.EnvId;
						const repo = path.join(options.cwd, name(options.kind, "project"));

						const cleanup = fs
							.rm(path.dirname(marker), { recursive: true, force: true })
							.pipe(Effect.andThen(fs.rm(repo, { recursive: true, force: true })), Effect.ignore);

						const program = Effect.gen(function* () {
							const git = yield* prepareRepository({
								kind: options.kind,
								repo,
								envId: mappedEnvId,
								fs,
								shell,
							});

							const sandbox = Layer.mergeAll(
								Layer.succeed(SandboxFileSystem.Service, fs),
								Layer.succeed(Shell, shell),
								SandboxEnv.layer(mappedEnvId),
							);
							const project = Project.layer.pipe(
								Layer.provide(Git.layer),
								Layer.provide(ProjectCopy.layer),
								Layer.provide(sandbox),
							);
							const application = Layer.merge(project, Session.layer).pipe(
								Layer.provide(Database.layer(":memory:")),
							);

							const persisted = yield* Effect.gen(function* () {
								const projects = yield* Project.Service;
								const sessions = yield* Session.Service;
								const info = yield* projects.fromDirectory(AbsolutePath.make(repo));
								const directories = yield* projects.directories({ projectId: info.id });
								const created = yield* sessions.create({
									projectId: info.id,
									slug: `${options.kind}-${Date.now()}`,
									directory: AbsolutePath.make(repo),
									title: `${options.kind} integration`,
									sandboxEnvId: mappedEnvId,
								});
								const reloaded = yield* sessions.get(created.id);
								return {
									directories,
									projectId: info.id,
									projectName: info.name,
									sessionEnvId: Option.getOrThrow(reloaded).sandboxEnvId,
								};
							}).pipe(Effect.provide(application));

							return {
								mappedEnvId,
								marker: yield* fs.readFile(marker),
								pwd: yield* shell.execArgv(["pwd"]),
								repo,
								git,
								...persisted,
							};
						});

						return yield* program.pipe(Effect.ensuring(cleanup));
					}),
				);

				expect(mapped.mappedEnvId).toBe(envId);
				expect(mapped.marker).toBe("reattached");
				expect(mapped.pwd.exitCode).toBe(0);
				expect(mapped.git.head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
				expect(mapped.git.originHead.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
				expect(mapped.git.head.stdout.trim()).not.toBe(mapped.git.originHead.stdout.trim());
				expect(mapped.git.ahead.stdout.trim()).toBe("1");
				expect(mapped.git.branch.stdout.trim()).toBe("main");
				expect(mapped.git.origin.stdout.trim()).toBe(remote);
				expect(mapped.git.status.stdout).toBe("");
				expect(mapped.git.subject.stdout.trim()).toBe(`test: ${options.kind} sandbox IO`);
				expect(mapped.projectId).toBe(Hash.fast("git:github.com/codeworksh/69th"));
				expect(mapped.projectName).toBe("69th");
				expect(mapped.directories).toEqual([{ directory: mapped.repo, sandboxEnvID: envId, type: "main" }]);
				expect(mapped.sessionEnvId).toBe(envId);
			},
			options.timeout,
		);

		const pushIt = options.githubPat === undefined ? it.skip : it;
		pushIt(
			"pushes a commit to a retained GitHub test branch",
			async () => {
				const githubPat = options.githubPat;
				if (githubPat === undefined) throw new Error("GITHUB_PAT is required for the live push contract");

				const repo = path.join(options.cwd, name(options.kind, "push"));
				const branch = `sandbox-contract/${options.kind}-${Date.now()}`;
				const ref = `refs/heads/${branch}`;
				const auth = githubAuth(githubPat);

				const result = await options.run(
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const envId = yield* SandboxEnv.EnvId;

						const push = (refspec: string) =>
							Effect.gen(function* () {
								const git = yield* Git.Service;
								return yield* git.push({ directory: repo, refspec, env: auth });
							}).pipe(Effect.provide(Git.layer));

						const program = Effect.gen(function* () {
							const prepared = yield* prepareRepository({
								kind: options.kind,
								repo,
								envId,
								fs,
								shell,
							});

							const pushed = yield* push(`HEAD:${ref}`);
							if (pushed.exitCode !== 0) {
								throw new Error(`unable to push remote test branch: ${pushed.stderr || pushed.text}`);
							}

							const advertised = yield* shell.execArgv(["git", "ls-remote", "--heads", remote, ref]);

							return { prepared, pushed, advertised, branch };
						});

						return yield* program.pipe(
							Effect.ensuring(fs.rm(repo, { recursive: true, force: true }).pipe(Effect.ignore)),
						);
					}),
				);

				const head = result.prepared.head.stdout.trim();
				expect(result.pushed.exitCode).toBe(0);
				expect(result.advertised.exitCode).toBe(0);
				expect(result.advertised.stdout.trim()).toBe(`${head}\trefs/heads/${result.branch}`);
			},
			options.timeout,
		);
	});
};
