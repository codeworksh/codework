import { Duration, Effect, Layer, Stream } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { type ExecChunk, Shell } from "../src/sandbox/shell/shell.ts";
import { bashTool } from "../src/tools/bash.ts";
import * as Executor from "../src/tools/executor.ts";
import { noop as progressNoop } from "../src/tools/progress.ts";
import { fromSandboxShell, local, ToolShell, ToolShellTimeout } from "../src/tools/shell.ts";
import * as Tool from "../src/tools/tool.ts";
import { pendingCall } from "./tools.fixture.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

// The real OS shell backend: ToolShell.local provided with the host spawner.
const localShell = (cwd?: string) => local(cwd ? { cwd } : undefined).pipe(Layer.provide(Sandbox.Process.host));

describe("ToolShell.local (real OS shell)", () => {
	it("runs a command and captures stdout + a zero exit", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("echo hello");
			}).pipe(Effect.provide(localShell())),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\n");
	});

	it("captures stderr and a non-zero exit", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("echo oops >&2; exit 3");
			}).pipe(Effect.provide(localShell())),
		);

		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("oops");
	});

	it("honors a per-call environment", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec('echo "$MY_VAR"', { env: { MY_VAR: "from-env" } });
			}).pipe(Effect.provide(localShell())),
		);

		expect(result.stdout).toBe("from-env\n");
	});

	it("runs in the configured working directory", async () => {
		await using tmp = await tmpdir();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("echo marker > created.txt");
			}).pipe(Effect.provide(localShell(tmp.path))),
		);

		expect(result.exitCode).toBe(0);
		expect(await fs.readFile(path.join(tmp.path, "created.txt"), "utf8")).toBe("marker\n");
	});

	it("times out a long command and returns promptly with ToolShellTimeout", async () => {
		// `Effect.flip` surfaces the failure as the success value, so a hang (no
		// timeout) would instead fail the run and the test.
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("sleep 30", { timeout: Duration.seconds(1) });
			}).pipe(Effect.provide(localShell()), Effect.flip),
		);

		expect(error).toBeInstanceOf(ToolShellTimeout);
		expect(error._tag).toBe("ToolShellTimeout");
	});

	it("streams many lines incrementally, in order, then a terminal exit", async () => {
		// The per-line sleep forces the OS to deliver output across several reads,
		// so this exercises real incremental streaming (not one buffered chunk) and
		// that line order is preserved across chunk boundaries.
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				if (shell.stream === undefined) throw new Error("ToolShell.local should support stream");
				return yield* shell.stream("for i in 1 2 3 4 5; do echo line$i; sleep 0.05; done").pipe(Stream.runCollect);
			}).pipe(Effect.provide(localShell())),
		);

		const decoder = new TextDecoder();
		let text = "";
		let exitCode: number | undefined;
		let outputChunks = 0;
		for (const event of events) {
			if (event._tag === "Exit") exitCode = event.exitCode;
			else {
				outputChunks++;
				text += decoder.decode(event.bytes);
			}
		}
		const lines = text.split("\n").filter((line) => line.length > 0);

		expect(lines).toEqual(["line1", "line2", "line3", "line4", "line5"]);
		expect(exitCode).toBe(0);
		expect(outputChunks).toBeGreaterThan(1);
	});

	it("force-kills a command that ignores SIGTERM on timeout", async () => {
		const started = Date.now();

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("trap '' TERM; sleep 2", { timeout: Duration.millis(100) });
			}).pipe(Effect.provide(localShell()), Effect.flip),
		);

		expect(error).toBeInstanceOf(ToolShellTimeout);
		expect(Date.now() - started).toBeLessThan(1_500);
	});

	it("honors a per-call forceKillAfter that overrides the adapter default", async () => {
		const started = Date.now();

		// Default config grace is 1s; a 200ms per-call override force-kills sooner.
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("trap '' TERM; sleep 2", {
					timeout: Duration.millis(100),
					forceKillAfter: Duration.millis(200),
				});
			}).pipe(Effect.provide(localShell()), Effect.flip),
		);

		expect(error).toBeInstanceOf(ToolShellTimeout);
		// ~100ms timeout + ~200ms grace ≪ the 1s default would allow.
		expect(Date.now() - started).toBeLessThan(800);
	});
});

describe("bash tool over ToolShell.local (pluggability)", () => {
	it("runs the same bash tool on the real OS shell by swapping only the backend", async () => {
		// ToolShell provided at registration (the erasure model), then run with no residual R.
		const executor = Executor.make([Tool.provide(bashTool, localShell())]);

		const outcome = await Effect.runPromise(
			executor.handle(pendingCall("bash", { command: "echo via-local" }, "c1")),
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.result.content[0]).toMatchObject({ type: "text", text: "via-local\n" });
	});

	it("preserves partial output when a streamed command times out (variant B)", async () => {
		// The bash tool uses ToolShell.local's `stream`, so output produced before
		// the deadline is accumulated and surfaced in the timeout result.
		//
		// The deadline has to cover a real spawn (node -> sh -> echo) plus the first
		// stdout chunk, so it is sized for a loaded machine rather than an idle one:
		// at 300ms this raced the spawn and captured no output at all when the suite
		// ran alongside the network-backed files. What is under test is that output
		// before the deadline survives, not how short the deadline is — `sleep 5`
		// still guarantees the timeout fires.
		const ctx = { callID: "c2", toolName: "bash", rawArgs: {} as Record<string, unknown> };

		const error = await Effect.runPromise(
			bashTool
				.handler({ command: "echo partial-line; sleep 5", timeout: 2 }, ctx)
				.pipe(Effect.provide(localShell()), Effect.provide(progressNoop), Effect.flip),
		);

		expect((error as { _tag: string })._tag).toBe("BashTimedOut");
		expect((error as { output: string }).output).toContain("partial-line");
	});
});

// §8.3: `exec`, `execArgv`, and `stream` all take one options shape, and
// `ToolShell.fromSandboxShell` forwards it. A backend that accepts the shape but
// drops `cwd` is a contract violation — the shell would silently run somewhere
// other than `Current` and the filesystem — so the bridge is asserted against a
// recording stub rather than inferred from the backends that happen to honour it.
describe("ToolShell.fromSandboxShell (options pass-through)", () => {
	const recorder = () => {
		const seen: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
		const record = (command: string, options?: { cwd?: string; env?: Record<string, string> }) => {
			seen.push({ command, cwd: options?.cwd, env: options?.env });
		};
		const layer = Layer.succeed(
			Shell,
			Shell.of({
				exec: (command, options) => {
					record(command, options);
					return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
				},
				execArgv: (argv, options) => {
					record(argv.join(" "), options);
					return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
				},
				stream: (command, options) => {
					record(command, options);
					return Stream.succeed<ExecChunk>({ _tag: "exit", exitCode: 0 });
				},
			}),
		);

		return { seen, layer: fromSandboxShell.pipe(Layer.provide(layer)) };
	};

	it("forwards cwd and env through exec", async () => {
		const { seen, layer } = recorder();

		await Effect.runPromise(
			Effect.flatMap(ToolShell, (shell) => shell.exec("pwd", { cwd: "nested", env: { A: "1" } })).pipe(
				Effect.provide(layer),
			),
		);

		expect(seen).toEqual([{ command: "pwd", cwd: "nested", env: { A: "1" } }]);
	});

	it("forwards cwd and env through stream", async () => {
		const { seen, layer } = recorder();

		await Effect.runPromise(
			Effect.flatMap(ToolShell, (shell) =>
				Stream.runDrain(shell.stream!("pwd", { cwd: "/abs", env: { B: "2" } })),
			).pipe(Effect.provide(layer)),
		);

		expect(seen).toEqual([{ command: "pwd", cwd: "/abs", env: { B: "2" } }]);
	});

	it("omits both when the caller passes neither", async () => {
		const { seen, layer } = recorder();

		await Effect.runPromise(Effect.flatMap(ToolShell, (shell) => shell.exec("pwd")).pipe(Effect.provide(layer)));

		expect(seen).toEqual([{ command: "pwd", cwd: undefined, env: undefined }]);
	});
});
