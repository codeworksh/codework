import { Effect, Fiber, Schema } from "effect";
import { posix as path } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../../src/sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { quote, Shell, type ExecResult } from "../../src/sandbox/shell/shell.ts";
import { fromSandboxShell, ToolShell, ToolShellTimeout } from "../../src/tool/shell.ts";
import { files, label, reference, windows } from "./scan.corpus.ts";

/**
 * The one contract every sandbox driver satisfies, so the built-in tools behave
 * the same on each. A driver that cannot meet a case declares it here, and the
 * case asserts the declared behaviour instead of being skipped: the day the
 * driver changes, the suite fails and says so.
 */
export interface ConformanceOptions {
	/** Names the artifact: `__artifacts__/sandbox.conformance.<driver>.json`. */
	readonly driver: string;
	/**
	 * Runs a program against a mounted sandbox. A runner rather than a Layer, so a
	 * remote suite reuses the one sandbox it already provisioned.
	 */
	readonly run: <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>) => Promise<A>;
	/** The mount's cwd, as `SandboxIO.Current` and `pwd` report it. */
	readonly cwd: string;
	/** The exec API returns one output field, kept as stdout (Daytona). */
	readonly combinesOutput: boolean;
	/** Interrupting the fiber stops the command (Daytona's exec API cannot). */
	readonly cancels: boolean;
	/** Commands see the harness process environment (the host, like Pi's `getShellEnv`). */
	readonly inheritsHostEnv: boolean;
	/** `uname -s` reports Linux. */
	readonly linux: boolean;
	readonly timeout?: number;
	/** Gap between the post-interrupt samples. Longer for remote drivers. */
	readonly settleMillis?: number;
}

/** Set in this process only: a driver that reports it runs commands with the harness environment. */
const HOST_ENV = { key: "CW_CONFORMANCE_HOST", value: "harness-process" };
process.env[HOST_ENV.key] = HOST_ENV.value;

type Services = Sandbox.Provides | ToolShell;

const errorKind = (error: { readonly cause?: unknown }) =>
	SandboxFileSystem.isNotFoundError(error.cause) ? "not-found" : "error";

/** Count of non-empty lines in a witness file a command appends to; 0 while it is missing. */
const ticks = (fs: SandboxFileSystem.Interface, witness: string) =>
	fs.readFile(witness).pipe(
		Effect.map((content) => content.split("\n").filter((line) => line.length > 0).length),
		Effect.orElseSucceed(() => 0),
	);

/**
 * Fork `command`, wait until it has appended to `witness`, interrupt it, and
 * sample the witness twice. Whether the count still moves is the evidence: a
 * fiber that unwinds promptly can leave the command running underneath.
 */
export const interruptWitness = (command: string, witness: string, settleMillis: number) =>
	Effect.gen(function* () {
		const fs = yield* SandboxFileSystem.Service;
		const shell = yield* Shell;
		const fiber = yield* Effect.forkChild(shell.exec(command));
		yield* Effect.gen(function* () {
			while ((yield* ticks(fs, witness)) < 1) yield* Effect.sleep("50 millis");
		}).pipe(Effect.timeout("60 seconds"), Effect.orDie);
		yield* Fiber.interrupt(fiber);
		// A driver may finish the iteration in flight before it notices.
		yield* Effect.sleep(settleMillis);
		const settled = yield* ticks(fs, witness);
		yield* Effect.sleep(settleMillis);
		return { settled, later: yield* ticks(fs, witness) };
	});

export const conformanceSpec = (options: ConformanceOptions) => {
	const timeout = options.timeout ?? 60_000;
	const settle = options.settleMillis ?? 2000;
	const observed: Record<string, unknown> = {};

	/**
	 * Run `body` in a scratch directory under the mount cwd that exists neither
	 * before nor after, so cases never collide on a shared sandbox. The body gets
	 * the directory both relative to the cwd and absolute.
	 */
	const scratch = <A, E>(
		name: string,
		body: (dir: { readonly rel: string; readonly root: string }) => Effect.Effect<A, E, Services>,
	) =>
		options.run(
			Effect.gen(function* () {
				const current = yield* SandboxIO.Current;
				const fs = yield* SandboxFileSystem.Service;
				const rel = `cw-conformance-${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
				const root = path.join(current.cwd, rel);
				return yield* body({ rel, root }).pipe(
					Effect.ensuring(fs.rm(root, { recursive: true, force: true }).pipe(Effect.ignore)),
				);
			}).pipe(Effect.provide(fromSandboxShell)),
		);

	/** Keep a case's observations for the artifact, with run-specific paths replaced. */
	const record = <A>(name: string, value: A): A => {
		observed[name] = JSON.parse(
			JSON.stringify(value)
				.replace(/cw-conformance-[a-z]+(-[a-z]+)*-[0-9a-z]+/g, "<scratch>")
				.replaceAll(options.cwd === "/" ? "\u0000" : options.cwd, "<cwd>"),
		);
		return value;
	};

	const test = (name: string, body: () => Promise<void>) => it(name, body, timeout);

	describe(`sandbox conformance — ${options.driver}`, () => {
		describe("filesystem", () => {
			test("round-trips utf-8, overwrites, and creates missing parents on write", async () => {
				const result = await scratch("write", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(`${rel}/file.txt`, "héllo\nwörld\n🚀");
						const utf8 = yield* fs.readFile(`${rel}/file.txt`);
						yield* fs.writeFile(`${rel}/file.txt`, "second");
						const overwritten = yield* fs.readFile(`${rel}/file.txt`);
						yield* fs.writeFile(`${rel}/deeply/nested/dir/file.txt`, "data");
						return {
							utf8,
							overwritten,
							nested: yield* fs.readFile(`${rel}/deeply/nested/dir/file.txt`),
							parent: (yield* fs.stat(`${rel}/deeply/nested/dir`)).isDirectory,
						};
					}),
				);
				expect(record("write", result)).toEqual({
					utf8: "héllo\nwörld\n🚀",
					overwritten: "second",
					nested: "data",
					parent: true,
				});
			});

			test("rejects reading a missing file as not found, and a directory", async () => {
				const result = await scratch("read-errors", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.mkdir(`${rel}/dir`, { recursive: true });
						return {
							missing: errorKind(yield* Effect.flip(fs.readFile(`${rel}/missing.txt`))),
							directory: (yield* Effect.flip(fs.readFile(`${rel}/dir`)))._tag,
						};
					}),
				);
				expect(record("read-errors", result)).toEqual({
					missing: "not-found",
					directory: "SandboxFileSystemError",
				});
			});

			test("reads raw bytes and byte ranges, binary-safe", async () => {
				const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
				const result = await scratch("bytes", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const file = `${rel}/bytes.dat`;
						yield* fs.writeFile(file, bytes);
						const buffer = yield* fs.readFileBuffer(file);
						return {
							buffer:
								buffer instanceof Uint8Array && buffer.length === 300 && buffer.every((b, i) => b === i % 256),
							head: [...(yield* fs.readBytes(file, 0, 4))],
							middle: [...(yield* fs.readBytes(file, 254, 4))],
							end: [...(yield* fs.readBytes(file, 298, 10))],
							past: (yield* fs.readBytes(file, 400, 10)).length,
							missing: errorKind(yield* Effect.flip(fs.readBytes(`${rel}/missing`, 0, 4))),
						};
					}),
				);
				expect(record("bytes", result)).toEqual({
					buffer: true,
					head: [0, 1, 2, 3],
					middle: [254, 255, 0, 1],
					end: [42, 43],
					past: 0,
					missing: "not-found",
				});
			});

			test("scans line windows exactly like the reference scanner", async () => {
				const result = await scratch("scan", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						// A remote SDK may decode one U+FFFD per invalid byte where TextDecoder
						// emits one per sequence.
						const replacements = (scan: SandboxFileSystem.LineScan) =>
							JSON.stringify({ ...scan, text: scan.text.replace(/�+/g, "�") });
						const mismatches: Array<string> = [];
						for (const [file, bytes] of Object.entries(files)) {
							yield* fs.writeFile(`${rel}/${file}`, bytes);
							for (const window of windows) {
								const scanned = yield* fs.scanLines(`${rel}/${file}`, window);
								if (replacements(scanned) !== replacements(reference(bytes, window)))
									mismatches.push(`${file} ${label(window)}: ${JSON.stringify(scanned)}`);
							}
						}
						return {
							mismatches,
							missing: errorKind(yield* Effect.flip(fs.scanLines(`${rel}/missing`, windows[0]!))),
						};
					}),
				);
				expect(record("scan", result)).toEqual({ mismatches: [], missing: "not-found" });
			});

			test("stats files and directories, and lstat sees a symlink stat follows", async () => {
				const result = await scratch("stat", ({ rel, root }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						yield* fs.writeFile(`${rel}/file.txt`, "data");
						yield* fs.mkdir(`${rel}/dir`, { recursive: true });
						const linked = yield* shell.exec(`ln -s file.txt ${quote(`${root}/link.txt`)}`, { cwd: rel });
						const file = yield* fs.stat(`${rel}/file.txt`);
						const dir = yield* fs.stat(`${rel}/dir`);
						const link = yield* fs.stat(`${rel}/link.txt`);
						const lstat = fs.lstat;
						return {
							file: { isFile: file.isFile, isDirectory: file.isDirectory, size: file.size },
							dir: { isFile: dir.isFile, isDirectory: dir.isDirectory },
							linked: linked.exitCode,
							link: { isFile: link.isFile, isSymbolicLink: link.isSymbolicLink ?? false },
							lstat:
								lstat === undefined
									? "absent"
									: {
											file: (yield* lstat(`${rel}/file.txt`)).isSymbolicLink,
											link: (yield* lstat(`${rel}/link.txt`)).isSymbolicLink,
										},
							missing: errorKind(yield* Effect.flip(fs.stat(`${rel}/missing`))),
						};
					}),
				);
				expect(record("stat", result)).toEqual({
					file: { isFile: true, isDirectory: false, size: 4 },
					dir: { isFile: false, isDirectory: true },
					linked: 0,
					link: { isFile: true, isSymbolicLink: false },
					lstat: { file: false, link: true },
					missing: "not-found",
				});
			});

			test("lists entry names, reports existence, and creates directories", async () => {
				const result = await scratch("dirs", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(`${rel}/a.txt`, "a");
						yield* fs.writeFile(`${rel}/.hidden`, "h");
						yield* fs.mkdir(`${rel}/sub/deep/er`, { recursive: true });
						return {
							entries: [...(yield* fs.readdir(rel))].sort(),
							readdirMissing: errorKind(yield* Effect.flip(fs.readdir(`${rel}/missing`))),
							exists: {
								root: yield* fs.exists("/"),
								file: yield* fs.exists(`${rel}/a.txt`),
								dir: yield* fs.exists(`${rel}/sub/deep/er`),
								missing: yield* fs.exists(`${rel}/missing.txt`),
								missingNested: yield* fs.exists(`${rel}/missing/deeply/nested`),
							},
							mkdirWithoutParent: (yield* Effect.flip(fs.mkdir(`${rel}/x/y/z`)))._tag,
						};
					}),
				);
				expect(record("dirs", result)).toEqual({
					entries: [".hidden", "a.txt", "sub"],
					readdirMissing: "not-found",
					exists: { root: true, file: true, dir: true, missing: false, missingNested: false },
					mkdirWithoutParent: "SandboxFileSystemError",
				});
			});

			test("removes files and trees, refuses a non-empty directory, and pardons missing under force", async () => {
				const result = await scratch("rm", ({ rel }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(`${rel}/file.txt`, "data");
						yield* fs.writeFile(`${rel}/tree/nested/file.txt`, "data");
						yield* fs.rm(`${rel}/file.txt`);
						const nonEmpty = (yield* Effect.flip(fs.rm(`${rel}/tree`)))._tag;
						yield* fs.rm(`${rel}/tree`, { recursive: true });
						return {
							file: yield* fs.exists(`${rel}/file.txt`),
							nonEmpty,
							tree: yield* fs.exists(`${rel}/tree`),
							missing: errorKind(yield* Effect.flip(fs.rm(`${rel}/missing.txt`))),
							forced: yield* fs.rm(`${rel}/missing.txt`, { force: true }).pipe(Effect.as("ok")),
						};
					}),
				);
				expect(record("rm", result)).toEqual({
					file: false,
					nonEmpty: "SandboxFileSystemError",
					tree: false,
					missing: "not-found",
					forced: "ok",
				});
			});
		});

		describe("paths", () => {
			test("resolves relative paths against the cwd, normalises `..`, and clamps `..` at `/`", async () => {
				const result = await scratch("paths", ({ rel, root }) =>
					Effect.gen(function* () {
						const current = yield* SandboxIO.Current;
						const fs = yield* SandboxFileSystem.Service;
						yield* fs.writeFile(`${rel}/file.txt`, "resolved");
						// Resolution, not confinement: `..` past `/` stays at `/`.
						const depth = current.cwd.split("/").filter(Boolean).length;
						return {
							cwd: current.cwd,
							absolute: yield* fs.readFile(`${root}/file.txt`),
							// `nested` never exists: lexical normalisation is why this resolves.
							normalised: yield* fs.readFile(`${rel}/./nested/../file.txt`),
							pastRoot: yield* fs.readFile(`/../..${root}/file.txt`),
							pastRootRelative: yield* fs.readFile(`${"../".repeat(depth + 3)}${root.slice(1)}/file.txt`),
						};
					}),
				);
				expect(result.cwd).toBe(options.cwd);
				expect(record("paths", result)).toEqual({
					cwd: result.cwd,
					absolute: "resolved",
					normalised: "resolved",
					pastRoot: "resolved",
					pastRootRelative: "resolved",
				});
			});
		});

		describe("filesystem and shell", () => {
			test("see each other's writes", async () => {
				const result = await scratch("shared", ({ rel, root }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						yield* fs.writeFile(`${rel}/from-fs.txt`, "filesystem");
						const fromFs = yield* shell.exec(`cat ${quote(`${root}/from-fs.txt`)}`);
						yield* shell.exec(`printf %s shell > ${quote(`${root}/from-shell.txt`)}`);
						const fromShell = yield* fs.readFile(`${rel}/from-shell.txt`);
						yield* fs.writeFile(`${rel}/from-shell.txt`, "overwritten");
						const overwritten = yield* shell.execArgv(["cat", `${root}/from-shell.txt`]);
						return { fromFs: fromFs.stdout, fromShell, overwritten: overwritten.stdout };
					}),
				);
				expect(record("shared", result)).toEqual({
					fromFs: "filesystem",
					fromShell: "shell",
					overwritten: "overwritten",
				});
			});
		});

		describe("shell", () => {
			test("returns exit codes and output as a result, never an error", async () => {
				const result = await scratch("exit", () =>
					Effect.gen(function* () {
						const shell = yield* Shell;
						const pick = ({ exitCode, stdout, stderr }: ExecResult) => ({ exitCode, stdout, stderr });
						return {
							ok: pick(yield* shell.exec("printf ok")),
							failed: pick(yield* shell.exec("printf out; printf err >&2; exit 7")),
							// argv is never parsed by a shell
							literal: (yield* shell.execArgv(["printf", "%s", "two words;$(echo pwned)"])).stdout,
						};
					}),
				);
				expect(record("exit", result)).toEqual({
					ok: { exitCode: 0, stdout: "ok", stderr: "" },
					failed: options.combinesOutput
						? { exitCode: 7, stdout: "outerr", stderr: "" }
						: { exitCode: 7, stdout: "out", stderr: "err" },
					literal: "two words;$(echo pwned)",
				});
			});

			test("scopes per-command env to that command and declares host env inheritance", async () => {
				const result = await scratch("env", () =>
					Effect.gen(function* () {
						const shell = yield* Shell;
						const scoped = yield* shell.exec('printf %s "$CW_SCOPED"', { env: { CW_SCOPED: "scoped" } });
						const after = yield* shell.exec('printf %s "$CW_SCOPED"');
						const host = yield* shell.exec(`printf %s "$${HOST_ENV.key}"`);
						return { scoped: scoped.stdout, after: after.stdout, host: host.stdout };
					}),
				);
				expect(record("env", result)).toEqual({
					scoped: "scoped",
					after: "",
					host: options.inheritsHostEnv ? HOST_ENV.value : "",
				});
			});

			test("runs in the mount cwd, and a relative command cwd resolves against it", async () => {
				const result = await scratch("cwd", ({ rel, root }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						yield* fs.writeFile(`${rel}/file.txt`, "cwd content");
						return {
							pwd: (yield* shell.exec("pwd")).stdout.trim(),
							argvPwd: (yield* shell.execArgv(["pwd"])).stdout.trim(),
							override: (yield* shell.exec("pwd", { cwd: rel })).stdout.trim(),
							argvOverride: (yield* shell.execArgv(["pwd"], { cwd: rel })).stdout.trim(),
							read: (yield* shell.exec("cat file.txt", { cwd: rel })).stdout,
							after: (yield* shell.exec("pwd")).stdout.trim(),
							root,
						};
					}),
				);
				expect(result).toEqual({
					pwd: options.cwd,
					argvPwd: options.cwd,
					override: result.root,
					argvOverride: result.root,
					read: "cwd content",
					after: options.cwd,
					root: result.root,
				});
				record("cwd", result);
			});

			test("runs compound commands, pipelines, redirection, and find", async () => {
				const result = await scratch("vocabulary", ({ root }) =>
					Effect.gen(function* () {
						const shell = yield* Shell;
						const tree = quote(`${root}/tree`);
						return {
							compound: (yield* shell.exec("printf 'step1\\n' && printf 'step2\\n'")).stdout,
							pipe: (yield* shell.exec("printf 'a\\nb\\nc\\n' | wc -l")).stdout.trim(),
							redirect: (yield* shell.exec(
								`mkdir -p ${quote(root)} && printf %s redirected > ${quote(`${root}/r.txt`)} && cat ${quote(`${root}/r.txt`)}`,
							)).stdout,
							find: (yield* shell.exec(
								`mkdir -p ${tree} && touch ${tree}/a ${tree}/b ${tree}/c && find ${tree} -type f | wc -l`,
							)).stdout.trim(),
							// Recorded against the declaration, so the host artifact is the same on every OS.
							uname:
								((yield* shell.exec("uname -s")).stdout.trim() === "Linux") === options.linux
									? "as declared"
									: "differs",
						};
					}),
				);
				expect(record("vocabulary", result)).toEqual({
					compound: "step1\nstep2\n",
					pipe: "3",
					redirect: "redirected",
					find: "3",
					uname: "as declared",
				});
			});

			test("returns large output whole through ToolShell", async () => {
				const result = await scratch("output", () =>
					Effect.gen(function* () {
						const tool = yield* ToolShell;
						const output = yield* tool.exec("seq 1 20000");
						const lines = output.stdout.split("\n").filter(Boolean);
						return { exitCode: output.exitCode, lines: lines.length, first: lines[0], last: lines.at(-1) };
					}),
				);
				expect(record("output", result)).toEqual({ exitCode: 0, lines: 20000, first: "1", last: "20000" });
			});

			test("fails a command past its deadline with a typed ToolShellTimeout", async () => {
				const result = await scratch("timeout", () =>
					Effect.gen(function* () {
						const tool = yield* ToolShell;
						const started = Date.now();
						const error = yield* Effect.flip(tool.exec("sleep 30", { timeout: "200 millis" }));
						return {
							error: Schema.is(ToolShellTimeout)(error)
								? { _tag: error._tag, millis: error.timeoutMillis }
								: error,
							// returned at the deadline, not after the command's own 30s
							prompt: Date.now() - started < 20_000,
						};
					}),
				);
				expect(record("timeout", result)).toEqual({
					error: { _tag: "ToolShellTimeout", millis: 200 },
					prompt: true,
				});
			});

			/**
			 * `shell.exec` is evaluated eagerly as `andThen`'s argument, so a driver
			 * that starts work while constructing its Effect would create the marker.
			 */
			test("never starts a pre-interrupted command", async () => {
				const result = await scratch("pre-interrupted", ({ rel, root }) =>
					Effect.gen(function* () {
						const fs = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;
						yield* fs.mkdir(rel, { recursive: true });
						const fiber = yield* Effect.forkChild(
							Effect.interrupt.pipe(Effect.andThen(shell.exec(`touch ${quote(`${root}/marker`)}`))),
						);
						yield* Fiber.await(fiber);
						return { started: yield* fs.exists(`${rel}/marker`) };
					}),
				);
				expect(record("pre-interrupted", result)).toEqual({ started: false });
			});

			test(
				options.cancels
					? "stops a command mid-flight when its fiber is interrupted"
					: "declares that an interrupted command keeps running",
				async () => {
					const result = await scratch("interrupt", ({ rel, root }) =>
						Effect.gen(function* () {
							const fs = yield* SandboxFileSystem.Service;
							yield* fs.mkdir(rel, { recursive: true });
							const witness = `${root}/progress`;
							return yield* interruptWitness(
								`for i in $(seq 1 120); do echo tick >> ${quote(witness)}; sleep 1; done`,
								witness,
								settle,
							);
						}).pipe(Effect.scoped),
					);
					// It really was running when cut.
					expect(result.settled).toBeGreaterThan(0);
					const stopped = result.later === result.settled;
					expect(record("interrupt", { stopped })).toEqual({ stopped: options.cancels });
				},
			);
		});

		test("matches the artifact", async () => {
			const artifact = {
				driver: options.driver,
				declared: {
					combinesOutput: options.combinesOutput,
					cancels: options.cancels,
					inheritsHostEnv: options.inheritsHostEnv,
				},
				cases: observed,
			};
			await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/sandbox.conformance.${options.driver}.json`,
			);
		});
	});
};
