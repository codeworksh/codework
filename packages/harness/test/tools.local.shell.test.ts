import { Duration, Effect, Layer, Stream } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox";
import { bashTool } from "../src/tools/bash";
import * as Executor from "../src/tools/executor";
import { noop as progressNoop } from "../src/tools/progress";
import { local, ToolShell, ToolShellTimeout } from "../src/tools/shell";
import * as Tool from "../src/tools/tool";
import { tmpdir } from "./fixtures/tempdir";

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
			executor.handle({ callID: "c1", name: "bash", rawArgs: { command: "echo via-local" } }),
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.result.content[0]).toMatchObject({ type: "text", text: "via-local\n" });
	});

	it("preserves partial output when a streamed command times out (variant B)", async () => {
		// The bash tool uses ToolShell.local's `stream`, so output produced before
		// the deadline is accumulated and surfaced in the timeout result.
		const ctx = { callID: "c2", toolName: "bash", rawArgs: {} as Record<string, unknown> };

		const error = await Effect.runPromise(
			bashTool
				.handler({ command: "echo partial-line; sleep 5", timeout: 0.3 }, ctx)
				.pipe(Effect.provide(localShell()), Effect.provide(progressNoop), Effect.flip),
		);

		expect((error as { _tag: string })._tag).toBe("BashTimedOut");
		expect((error as { output: string }).output).toContain("partial-line");
	});
});
