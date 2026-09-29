import { Duration, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { type ExecChunk, Shell } from "../src/sandbox/shell/shell.ts";
import { bashTool } from "../src/plugin/builtin/tool/bash.ts";
import { noop as progressNoop } from "../src/tool/progress.ts";
import { fromSandboxShell, local, ToolShell, ToolShellTimeout } from "../src/tool/shell.ts";

// The real OS shell backend: ToolShell.local provided with the host spawner.
const localShell = (cwd?: string) => local(cwd ? { cwd } : undefined).pipe(Layer.provide(Sandbox.Process.host));

describe("ToolShell.local (real OS shell)", () => {
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
});

describe("bash tool over ToolShell.local (pluggability)", () => {
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
			seen.push({
				command,
				...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options?.env === undefined ? {} : { env: options.env }),
			});
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
});
