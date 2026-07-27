import { Effect, Fiber, Layer } from "effect";
import fs from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { posix as path } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { SandboxIO } from "../src/sandbox/io";
import { Sandbox } from "../src/sandbox/sandbox";
import { quote, Shell } from "../src/sandbox/shell";
import { fromSandboxShell, ToolShell, ToolShellTimeout } from "../src/tools/shell";
import { tmpdir } from "./fixtures/tempdir";
import "./utils/env";

/**
 * Behavioral parity with Flue's checked-in filesystem and shell examples.
 *
 * References (vendored, read-only):
 * - `.repos/flue/examples/hello-world/src/agents/fs-surface-test.ts`
 * - `.repos/flue/examples/hello-world/src/agents/fs-test.ts`
 * - `.repos/flue/examples/hello-world/src/agents/with-sandbox.ts`
 * - `.repos/flue/examples/hello-world/src/agents/with-abort.ts`
 * - `.repos/flue/packages/runtime/src/sandbox.ts`
 * - `.repos/flue/packages/runtime/src/node/local-env.ts`
 *
 * These tests are independently written against the Harness contract and never
 * import Flue. "Model writes a file" from Flue's demo is represented by the
 * deterministic `SandboxFileSystem.Service` write below: that is the filesystem
 * boundary a model-facing file tool ultimately invokes, without making this
 * contract depend on a live model.
 *
 * API-shape differences are mapped to their Harness equivalents:
 * - Flue `AbortSignal` cancellation -> Effect fiber interruption.
 * - Flue `timeoutMs` -> the typed timeout on `ToolShell`.
 * - Flue `SessionEnv.cwd/resolvePath` -> `SandboxIO.Current`, plus the mount
 *   wrappers on local and virtual backends. Remote backends bypass
 *   `SandboxIO.mount` and resolve inside `RemoteFileSystem.make`; the same
 *   assertions cover that second path from `fixtures/remote.spec.ts`.
 *
 * **Local and virtual backends only.** The remote half of this matrix lives in
 * `fixtures/remote.spec.ts`, so it rides the single sandbox each provider suite
 * already provisions — a second box per provider would have bought duplicate
 * coverage against Vercel's ~40-creations-per-10-minute cap. Interruption is
 * likewise owned by `cancellationSpec` (see the note at the end of this file).
 */

type ParityServices = SandboxIO.Provides | ToolShell;

type Run = <A, E>(program: Effect.Effect<A, E, ParityServices>) => Promise<A>;

interface Backend {
	readonly name: string;
	readonly run: Run;
	readonly root: () => string;
	readonly expectedCwd: () => string;
	readonly canonicalizeCwd?: (cwd: string) => Promise<string>;
	readonly linux: boolean;
}

const withToolShell = <E, RIn>(sandbox: Layer.Layer<SandboxIO.Provides, E, RIn>): Layer.Layer<ParityServices, E, RIn> =>
	Layer.provideMerge(fromSandboxShell, sandbox);

const layerRunner =
	<E>(make: () => Layer.Layer<ParityServices, E>): Run =>
	(program) =>
		Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(make())));

const cleanup = (filesystem: SandboxFileSystem.Interface, root: string) =>
	filesystem.rm(root, { recursive: true, force: true }).pipe(Effect.ignore);

/**
 * Run `body` against a scratch directory that exists neither before nor after.
 *
 * Only the host needs this. Memory and sqldb build a fresh VFS per `run`, so
 * nothing survives to collide with — for them `root()` names a path inside a
 * tree that is discarded with the test. The host is the one backend where
 * `directory` is real and shared across the file, so the cleanup is what keeps
 * one test's leftovers out of the next one's `readdir`. Applied uniformly so the
 * spec body below reads the same on every backend.
 */
const inCleanRoot = <A, E>(
	backend: Backend,
	name: string,
	body: (root: string) => Effect.Effect<A, E, ParityServices>,
): Promise<A> =>
	backend.run(
		Effect.gen(function* () {
			const filesystem = yield* SandboxFileSystem.Service;
			const root = path.join(backend.root(), name);
			yield* cleanup(filesystem, root);
			return yield* body(root).pipe(Effect.ensuring(cleanup(filesystem, root)));
		}),
	);

const paritySpec = (backend: Backend) => {
	const timeout = 30_000;

	describe(`Flue parity — ${backend.name}`, () => {
		/**
		 * Flue reference: `fs-surface-test.ts`.
		 * Covers every method that demo exercises, including cross-surface
		 * visibility from the filesystem API into the shell.
		 */
		it(
			"matches the Flue filesystem-surface scenario",
			async () => {
				const result = await inCleanRoot(backend, "fs-surface", (root) =>
					Effect.gen(function* () {
						const filesystem = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const text = path.join(root, "agent.txt");
						const visible = path.join(root, "agent-visible.txt");
						const scratch = path.join(root, "scratch");
						const statTarget = path.join(root, "stat-target.txt");

						yield* filesystem.writeFile(text, "agent.fs content");
						yield* filesystem.writeFile(visible, "staged by harness.fs");
						yield* filesystem.mkdir(scratch, { recursive: true });
						yield* filesystem.writeFile(path.join(scratch, "a.txt"), "a");
						yield* filesystem.writeFile(path.join(scratch, "b.txt"), "b");
						yield* filesystem.writeFile(statTarget, "hello");

						const entries = [...(yield* filesystem.readdir(scratch))].sort();
						const existed = yield* filesystem.exists(path.join(scratch, "a.txt"));
						const stat = yield* filesystem.stat(statTarget);
						const bytes = yield* filesystem.readFileBuffer(statTarget);
						const shellRead = yield* shell.exec(`cat ${quote(visible)}`);

						yield* filesystem.rm(scratch, { recursive: true, force: true });

						return {
							text: yield* filesystem.readFile(text),
							shellRead,
							entries,
							existed,
							removed: !(yield* filesystem.exists(path.join(scratch, "a.txt"))),
							stat,
							bytes,
						};
					}),
				);

				expect(result.text).toBe("agent.fs content");
				expect(result.shellRead).toMatchObject({ exitCode: 0, stdout: "staged by harness.fs" });
				expect(result.entries).toEqual(["a.txt", "b.txt"]);
				expect(result.existed).toBe(true);
				expect(result.removed).toBe(true);
				expect(result.stat.isFile).toBe(true);
				expect(result.stat.size).toBe(5);
				expect(result.bytes).toBeInstanceOf(Uint8Array);
				expect(new TextDecoder().decode(result.bytes)).toBe("hello");
			},
			timeout,
		);

		/**
		 * Flue reference: `fs-test.ts`.
		 * The Flue demo alternates shell writes with model-facing file-tool writes.
		 * Here the filesystem service stands in for that tool boundary, making the
		 * same shared-tree assertion deterministic.
		 */
		it(
			"keeps shell and model-facing filesystem mutations mutually visible",
			async () => {
				const result = await inCleanRoot(backend, "cross-surface", (root) =>
					Effect.gen(function* () {
						const filesystem = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const instructions = path.join(root, "AGENTS.md");
						const modelFile = path.join(root, "hello.txt");
						const shellFile = path.join(root, "shell-created.txt");

						yield* shell.exec(
							`mkdir -p ${quote(root)} && printf %s ${quote("Seeded workspace instructions")} > ${quote(instructions)}`,
						);
						const seeded = yield* shell.exec(`cat ${quote(instructions)}`);

						yield* filesystem.writeFile(modelFile, "Hello from the agent");
						const modelWrite = yield* shell.exec(`cat ${quote(modelFile)}`);

						yield* filesystem.writeFile(instructions, "MODIFIED BY AGENT");
						const modelOverwrite = yield* shell.exec(`cat ${quote(instructions)}`);

						yield* shell.exec(`printf %s ${quote("shell content")} > ${quote(shellFile)}`);
						const shellWrite = yield* filesystem.readFile(shellFile);

						return { seeded, modelWrite, modelOverwrite, shellWrite };
					}),
				);

				expect(result.seeded.stdout).toBe("Seeded workspace instructions");
				expect(result.modelWrite.stdout).toBe("Hello from the agent");
				expect(result.modelOverwrite.stdout).toBe("MODIFIED BY AGENT");
				expect(result.shellWrite).toBe("shell content");
			},
			timeout,
		);

		/**
		 * Flue reference: `with-sandbox.ts`.
		 * The original runs this scenario on Daytona; keeping it in the shared
		 * contract proves the same shell vocabulary survives every adapter.
		 */
		it(
			"matches the Flue compound-command, pipeline, redirection, and find scenario",
			async () => {
				const result = await inCleanRoot(backend, "shell-primitives", (root) =>
					Effect.gen(function* () {
						const shell = yield* Shell;
						const redirected = path.join(root, "redirected.txt");
						const files = path.join(root, "pipe-test");

						const compound = yield* shell.exec("printf 'step1\\n' && printf 'step2\\n'");
						const pipe = yield* shell.exec("printf 'a\\nb\\nc\\n' | wc -l");
						const redirect = yield* shell.exec(
							`mkdir -p ${quote(root)} && printf %s ${quote("redirected content")} > ${quote(redirected)}`,
						);
						const readRedirect = yield* shell.exec(`cat ${quote(redirected)}`);
						const findWc = yield* shell.exec(
							`mkdir -p ${quote(files)} && touch ${quote(path.join(files, "a.txt"))} ${quote(path.join(files, "b.txt"))} ${quote(path.join(files, "c.txt"))} && find ${quote(files)} -type f | wc -l`,
						);
						const uname = backend.linux ? yield* shell.exec("uname -s") : undefined;

						return { compound, pipe, redirect, readRedirect, findWc, uname };
					}),
				);

				expect(result.compound).toMatchObject({ exitCode: 0, stdout: "step1\nstep2\n" });
				expect(result.pipe.exitCode).toBe(0);
				expect(result.pipe.stdout.trim()).toBe("3");
				expect(result.redirect.exitCode).toBe(0);
				expect(result.readRedirect.stdout).toBe("redirected content");
				expect(result.findWc.exitCode).toBe(0);
				expect(result.findWc.stdout.trim()).toBe("3");
				if (result.uname !== undefined) {
					expect(result.uname.exitCode).toBe(0);
					expect(result.uname.stdout.trim()).toBe("Linux");
				}
			},
			timeout,
		);

		/**
		 * Flue reference: `createCwdSessionEnv` and `createLocalSessionEnv`.
		 * Both APIs resolve relative filesystem and command paths against one
		 * immutable session cwd; a command override is scoped to that call.
		 */
		it(
			"matches Flue cwd resolution and operation-local override semantics",
			async () => {
				const result = await backend.run(
					Effect.gen(function* () {
						const current = yield* SandboxIO.Current;
						const filesystem = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const child = path.join(current.cwd, "flue-parity-cwd");

						yield* cleanup(filesystem, child);
						const program = Effect.gen(function* () {
							yield* filesystem.mkdir("flue-parity-cwd", { recursive: true });
							yield* filesystem.writeFile("flue-parity-cwd/file.txt", "cwd content");

							return {
								current: current.cwd,
								normalized: yield* filesystem.readFile("flue-parity-cwd/./nested/../file.txt"),
								absolute: yield* filesystem.readFile(path.join(child, "file.txt")),
								overridePwd: yield* shell.exec("pwd", { cwd: "flue-parity-cwd" }),
								overrideRead: yield* shell.exec("cat file.txt", { cwd: "flue-parity-cwd" }),
								afterPwd: yield* shell.exec("pwd"),
							};
						});
						return yield* program.pipe(Effect.ensuring(cleanup(filesystem, child)));
					}),
				);

				expect(result.current).toBe(backend.expectedCwd());
				expect(result.normalized).toBe("cwd content");
				expect(result.absolute).toBe("cwd content");
				const shellCwd =
					backend.canonicalizeCwd === undefined ? result.current : await backend.canonicalizeCwd(result.current);
				expect(result.overridePwd.stdout.trim()).toBe(path.join(shellCwd, "flue-parity-cwd"));
				expect(result.overrideRead.stdout).toBe("cwd content");
				expect(result.afterPwd.stdout.trim()).toBe(shellCwd);
			},
			timeout,
		);

		/**
		 * Flue reference: `SessionEnv.exec` and `with-sandbox.ts`.
		 * Command failures are results, while per-call environment values override
		 * only one command.
		 */
		it(
			"preserves stdout, stderr, exit code, and non-leaking command environment",
			async () => {
				const result = await backend.run(
					Effect.gen(function* () {
						const shell = yield* Shell;
						const configured = yield* shell.exec(`printf %s "$FLUE_PARITY_VALUE"`, {
							env: { FLUE_PARITY_VALUE: "configured" },
						});
						const after = yield* shell.exec(`printf %s "$FLUE_PARITY_VALUE"`);
						const failed = yield* shell.exec("printf out; printf err >&2; exit 7");
						return { configured, after, failed };
					}),
				);

				expect(result.configured).toMatchObject({ exitCode: 0, stdout: "configured" });
				expect(result.after.stdout).toBe("");
				// Every local backend reports the two streams separately. The one
				// backend that cannot — Daytona, whose exec API returns a single
				// combined field — is asserted in `remote.spec.ts` via `combinesOutput`.
				expect(result.failed).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
			},
			timeout,
		);

		/**
		 * Flue reference: `with-abort.ts` and `SessionEnv.exec({ timeoutMs })`.
		 * Harness owns this at the ToolShell boundary and returns a typed timeout.
		 */
		it(
			"maps Flue shell timeout semantics to ToolShellTimeout",
			async () => {
				const started = Date.now();
				const error = await backend.run(
					Effect.gen(function* () {
						const shell = yield* ToolShell;
						return yield* shell.exec("sleep 30", { timeout: "200 millis" }).pipe(Effect.flip);
					}),
				);

				expect(error).toBeInstanceOf(ToolShellTimeout);
				if (!(error instanceof ToolShellTimeout)) throw error;
				expect(error.timeoutMillis).toBe(200);
				expect(Date.now() - started).toBeLessThan(5_000);
			},
			timeout,
		);

		/**
		 * Flue reference: the pre-aborted branch in `with-abort.ts`, where every
		 * adapter opens `exec` with `if (signal?.aborted) throw abortErrorFor(...)`
		 * because most provider SDKs ignore the signal entirely.
		 *
		 * Effect gives that guarantee structurally — an interrupted fiber never
		 * reaches the call — so there is no explicit check left to test. What this
		 * does pin is the one way an implementation could still break it:
		 * `shell.exec` is evaluated eagerly as `andThen`'s argument, so a backend
		 * that starts work while *constructing* its Effect (the
		 * `Effect.promise(alreadyStartedPromise)` mistake) mutates the tree here and
		 * fails. Mid-flight abort is a different property, owned by
		 * `cancellationSpec` — see the note at the end of this file.
		 */
		it(
			"does not start a shell command after pre-interruption",
			async () => {
				const exists = await inCleanRoot(backend, "pre-interrupted", (root) =>
					Effect.gen(function* () {
						const filesystem = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						const marker = path.join(root, "should-not-exist");

						yield* filesystem.mkdir(root, { recursive: true });
						const fiber = yield* Effect.forkChild(
							Effect.interrupt.pipe(Effect.andThen(shell.exec(`touch ${quote(marker)}`))),
						);
						yield* Fiber.await(fiber);
						return yield* filesystem.exists(marker);
					}),
				);

				expect(exists).toBe(false);
			},
			timeout,
		);
	});
};

/**
 * Flue reference: the manual mid-flight shell abort in `with-abort.ts`.
 *
 * Not repeated here. `cancellationSpec` already runs against all five of these
 * backends — memory, sqldb, and host in `sandbox.cancellation.test.ts`, vercel in
 * `sandbox.vercel.test.ts`, daytona in `sandbox.daytona.test.ts` — and it asserts
 * more than Flue's demo does: not that the caller unwinds, but that the command's
 * filesystem witness stops advancing. Running it a sixth time would add two
 * settle windows per backend and no signal.
 */

describe("sandbox Flue parity", () => {
	describe("memory + just-bash", () => {
		paritySpec({
			name: "memory",
			run: layerRunner(() => withToolShell(Sandbox.memory())),
			root: () => "/tmp/flue-parity-memory",
			expectedCwd: () => "/",
			linux: false,
		});
	});

	describe("SQLite + just-bash", () => {
		paritySpec({
			name: "sqldb",
			run: layerRunner(() => withToolShell(Sandbox.sqldb())),
			root: () => "/tmp/flue-parity-sqldb",
			expectedCwd: () => "/",
			linux: false,
		});
	});

	describe("local host", () => {
		let directory = "";

		beforeAll(async () => {
			directory = (await tmpdir()).path;
		});
		afterAll(async () => {
			if (directory !== "") await fs.rm(directory, { recursive: true, force: true });
		});

		paritySpec({
			name: "host",
			run: layerRunner(() => withToolShell(Sandbox.local(directory))),
			root: () => directory,
			expectedCwd: () => directory,
			canonicalizeCwd: realpath,
			linux: process.platform === "linux",
		});
	});
});
