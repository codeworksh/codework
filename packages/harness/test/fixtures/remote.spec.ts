import { Effect, Layer, Option } from "effect";
import { Buffer } from "node:buffer";
import { posix as path } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../../src/db/db.ts";
import { Event } from "../../src/event/event.ts";
import { Git } from "../../src/git/git.ts";
import { Location } from "../../src/location/location.ts";
import { SandboxFileSystem } from "../../src/sandbox/fs/filesystem.ts";
import type { SandboxInstance } from "../../src/sandbox/instance.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { Sandbox } from "../../src/sandbox/sandbox.ts";
import { type ISandboxExe, Shell } from "../../src/sandbox/shell/shell.ts";
import { SandboxStore } from "../../src/sandbox/store.ts";
import { SessionLive } from "../../src/session/live.ts";
import { Session } from "../../src/session/session.ts";
import { Hash } from "../../src/util/hash.ts";

type Run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>) => Promise<A>;
/**
 * Attach a *second* mount to the same underlying resource, by the provider's own
 * locator. Stands in for what the control plane does when it reattaches a
 * namespace recorded in a project or session row.
 */
type Reattach = <A, E>(
	input: { readonly providerResourceId: string; readonly instanceId: SandboxInstance.ID },
	program: Effect.Effect<A, E, Sandbox.Provides>,
) => Promise<A>;

export interface RemoteSandboxSpecOptions {
	readonly kind: "vercel" | "daytona";
	readonly cwd: string;
	readonly inheritedEnv: {
		readonly key: string;
		readonly value: string;
	};
	readonly run: Run;
	readonly reattach: Reattach;
	/** The provider's own locator for the shared sandbox, read from its `Resource` service. */
	readonly resourceId: () => Promise<string>;
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
 * Live contract shared by remote providers, beyond the filesystem and shell
 * contract `conformanceSpec` covers. The provider test owns one sandbox and
 * supplies two runners: direct access to it, and a second mount reattached by
 * the provider's own locator.
 */
export const remoteSandboxSpec = (options: RemoteSandboxSpecOptions) => {
	describe("pluggable runtime contract", () => {
		it(
			"inherits the environment baked into the provider sandbox",
			async () => {
				const inherited = await options.run(
					Effect.flatMap(Shell, (shell) => shell.execArgv(["printenv", options.inheritedEnv.key])),
				);
				expect(inherited.stdout.trim()).toBe(options.inheritedEnv.value);
			},
			options.timeout,
		);

		it(
			"reattaches to the same namespace, then persists the project and session namespace",
			async () => {
				const marker = path.join(options.cwd, name(options.kind, "mapped"), "marker.txt");
				const providerResourceId = await options.resourceId();
				const envId = await options.run(
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(marker, "reattached");
						return (yield* SandboxIO.Current).id;
					}),
				);

				// The application id is minted, not derived: it says nothing about the
				// provider's own locator, which is exactly the separation §6.1 exists
				// for. So reattaching takes *both* halves, the way a project or session
				// row supplies them — the locator says which resource, the id says
				// which namespace it was registered as.
				expect(envId).not.toBe(providerResourceId);

				const mapped = await options.reattach(
					{ providerResourceId, instanceId: envId },
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const mappedEnvId = (yield* SandboxIO.Current).id;
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
								SandboxIO.mount(
									SandboxIO.remote({
										driver: options.kind,
										id: mappedEnvId,
										defaultCwd: options.cwd,
										cwd: repo,
									}),
								),
							);
							const database = Database.layer(":memory:");
							// Spaces are foreign-keyed to sandbox, so the remote
							// namespace has to be registered before anything claims to live
							// in it — and before Location resolves the repo into a space.
							const registered = Layer.effectDiscard(
								Effect.flatMap(SandboxStore.make, (store) =>
									store.register({
										id: mappedEnvId,
										driver: options.kind,
										kind: "remote",
										ownership: "external",
									}),
								),
							).pipe(Layer.provide(database));
							const location = Location.layerMounted().pipe(Layer.provide(sandbox), Layer.provide(registered));
							// provideMerge, not provide: `registered` and the block below
							// share the one in-memory database.
							const application = Layer.merge(location, SessionLive.layer).pipe(
								Layer.provideMerge(Event.layer),
								Layer.provideMerge(database),
							);

							const persisted = yield* Effect.gen(function* () {
								const resolved = yield* Location.Service;
								const sessions = yield* Session.Service;
								const created = yield* sessions.create({
									spaceId: resolved.space.id,
									directory: resolved.directory,
									title: `${options.kind} integration`,
								});
								const space = Option.getOrThrow(yield* sessions.space(created.session.id));
								return {
									space: {
										location: resolved.space.location,
										env: resolved.space.env,
										kind: resolved.space.kind,
									},
									directory: resolved.directory,
									projectId: resolved.project.id,
									projectName: resolved.project.name,
									// The session's env is its space's; a remote namespace is a real row.
									sessionEnvId: space.env,
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

				// Same namespace *and* same identity — the second mount carries the id
				// it was given rather than minting another for the same files.
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
				expect(mapped.space).toEqual({ location: mapped.repo, env: envId, kind: "primary" });
				expect(mapped.directory).toBe(mapped.repo);
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
						const envId = (yield* SandboxIO.Current).id;

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
