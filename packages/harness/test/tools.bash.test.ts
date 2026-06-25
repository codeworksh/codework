import { Effect, Exit, Layer, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox";
import { type ExecChunk, Shell as SandboxShell } from "../src/sandbox/shell";
import { bashTool } from "../src/tools/bash";
import * as Executor from "../src/tools/executor";
import { make as makeProgress, noop as progressNoop } from "../src/tools/progress";
import {
	fromSandboxShell,
	type IToolShell,
	ToolShell,
	type ToolShellEvent,
	ToolShellTimeout,
} from "../src/tools/shell";

// ToolShell backed by the in-process just-bash sandbox — the bootstrap backend
// (buffered exec, no `stream` → the tool takes variant A).
const justBashToolShell = fromSandboxShell.pipe(Layer.provide(Sandbox.EnvBash.services(Sandbox.EnvInMemory.layer())));

// A hand-made buffered ToolShell Layer with canned behaviour — for the def/exec split.
const stubToolShell = (exec: IToolShell["exec"]): Layer.Layer<ToolShell> =>
	Layer.succeed(ToolShell, ToolShell.of({ exec }));

// A hand-made streaming ToolShell Layer that replays canned events (variant B).
const streamingStub = (events: ReadonlyArray<ToolShellEvent>): Layer.Layer<ToolShell> =>
	Layer.succeed(
		ToolShell,
		ToolShell.of({
			exec: () => Effect.die(new Error("exec should not run for the streaming stub")),
			stream: () => Stream.fromIterable(events),
		}),
	);

const utf8 = new TextEncoder();
const output = (text: string): ToolShellEvent => ({ _tag: "Output", bytes: utf8.encode(text) });
const exited = (exitCode: number): ToolShellEvent => ({ _tag: "Exit", exitCode });

const ctx = { callID: "call-1", toolName: "bash", rawArgs: {} as Record<string, unknown> };

const call = (rawArgs: Record<string, unknown>) => ({ callID: "call-1", name: "bash", rawArgs });

describe("bash tool via Executor (just-bash backend)", () => {
	const executor = Executor.make([bashTool]);

	it("runs a command and returns a completed outcome", async () => {
		const outcome = await Effect.runPromise(
			executor.handle(call({ command: "echo hello" })).pipe(Effect.provide(justBashToolShell)),
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.result.isError).toBe(false);
		expect(outcome.result.content[0]).toMatchObject({ type: "text", text: "hello\n" });
		expect(outcome.result.details).toMatchObject({ exitCode: 0, truncated: false });
	});

	it("reports a non-zero exit as an error outcome carrying the output", async () => {
		const outcome = await Effect.runPromise(
			executor.handle(call({ command: "cat /missing.txt" })).pipe(Effect.provide(justBashToolShell)),
		);

		expect(outcome.status).toBe("error");
		expect(outcome.result.isError).toBe(true);
		const details = outcome.result.details as { _tag: string; exitCode: number };
		expect(details._tag).toBe("BashFailed");
		expect(details.exitCode).not.toBe(0);
	});

	it("rejects invalid arguments with an error outcome (model passed bad args)", async () => {
		const outcome = await Effect.runPromise(executor.handle(call({})).pipe(Effect.provide(justBashToolShell)));

		expect(outcome.status).toBe("error");
		expect(outcome.result.details).toMatchObject({ error: "invalid_arguments", name: "bash" });
	});

	for (const timeout of [0, -1]) {
		it(`rejects timeout=${timeout} before invoking the shell`, async () => {
			const layer = stubToolShell(() => Effect.die(new Error("shell should not run for invalid timeout")));

			const outcome = await Effect.runPromise(
				executor.handle(call({ command: "echo should-not-run", timeout })).pipe(Effect.provide(layer)),
			);

			expect(outcome.status).toBe("error");
			expect(outcome.result.details).toMatchObject({ error: "invalid_arguments", name: "bash" });
		});
	}

	it("carries truncation + a full-output path on failure too (symmetric with success)", async () => {
		const huge = "x\n".repeat(5_000);
		const layer = stubToolShell(() => Effect.succeed({ stdout: huge, stderr: "", exitCode: 1 }));

		const outcome = await Effect.runPromise(executor.handle(call({ command: "x" })).pipe(Effect.provide(layer)));

		expect(outcome.status).toBe("error");
		const details = outcome.result.details as { _tag: string; truncated: boolean; fullOutputPath?: string };
		expect(details._tag).toBe("BashFailed");
		expect(details.truncated).toBe(true);
		expect(details.fullOutputPath).toBeDefined();
	});
});

describe("bash tool error reconciliation (stub backend)", () => {
	const executor = Executor.make([bashTool]);

	it("maps a ToolShell timeout to a declared BashTimedOut", async () => {
		const layer = stubToolShell((command) => Effect.fail(new ToolShellTimeout({ command, timeoutMillis: 5_000 })));

		const outcome = await Effect.runPromise(
			executor.handle(call({ command: "sleep 100", timeout: 5 })).pipe(Effect.provide(layer)),
		);

		expect(outcome.status).toBe("error");
		expect((outcome.result.details as { _tag: string })._tag).toBe("BashTimedOut");
	});

	it("uses the ToolShellTimeout duration when encoding BashTimedOut details", async () => {
		const layer = stubToolShell((command) => Effect.fail(new ToolShellTimeout({ command, timeoutMillis: 12_500 })));

		const outcome = await Effect.runPromise(
			executor.handle(call({ command: "sleep 100", timeout: 5 })).pipe(Effect.provide(layer)),
		);

		expect(outcome.status).toBe("error");
		expect(outcome.result.details).toMatchObject({ _tag: "BashTimedOut", timeoutSeconds: 12.5 });
	});
});

describe("bash handler in isolation — buffered (def/exec split)", () => {
	it("runs against a stub ToolShell and returns the typed success value", async () => {
		const layer = stubToolShell(() => Effect.succeed({ stdout: "hi", stderr: "", exitCode: 0 }));

		const success = await Effect.runPromise(
			bashTool.handler({ command: "whatever" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(success).toEqual({ output: "hi", exitCode: 0, truncated: false });
	});

	it("fails with a typed BashFailed on non-zero exit", async () => {
		const layer = stubToolShell(() => Effect.succeed({ stdout: "", stderr: "boom", exitCode: 2 }));

		const exit = await Effect.runPromiseExit(
			bashTool.handler({ command: "whatever" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("truncates large output and records details + a spill path", async () => {
		const huge = "x\n".repeat(5_000);
		const layer = stubToolShell(() => Effect.succeed({ stdout: huge, stderr: "", exitCode: 0 }));

		const success = await Effect.runPromise(
			bashTool.handler({ command: "whatever" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(success.truncated).toBe(true);
		expect(success.fullOutputPath).toBeDefined();
		expect(success.output).toContain("[showing lines");
	});
});

describe("bash handler in isolation — streaming (variant B)", () => {
	it("accumulates streamed output and returns the exit code", async () => {
		const layer = streamingStub([output("line1\n"), output("line2\n"), exited(0)]);

		const success = await Effect.runPromise(
			bashTool.handler({ command: "x" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(success).toMatchObject({ exitCode: 0, truncated: false });
		expect(success.output).toBe("line1\nline2\n");
	});

	it("reports interim output via ToolProgress while streaming", async () => {
		const reports: string[] = [];
		const capturing = makeProgress((partial) =>
			Effect.sync(() => {
				const part = partial.content?.[0];
				if (part?.type === "text") reports.push(part.text);
			}),
		);
		const layer = streamingStub([output("first\n"), output("second\n"), exited(0)]);

		await Effect.runPromise(
			bashTool.handler({ command: "x" }, ctx).pipe(Effect.provide(layer), Effect.provide(capturing)),
		);

		expect(reports.length).toBeGreaterThan(0);
		expect(reports.at(-1)).toContain("second");
	});

	it("reports a non-zero streamed exit as BashFailed", async () => {
		const layer = streamingStub([output("nope\n"), exited(7)]);

		const exit = await Effect.runPromiseExit(
			bashTool.handler({ command: "x" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});
});

describe("fromSandboxShell streaming bridge (variant B over a backend Shell)", () => {
	// A sandbox Shell that supports `stream` (the shape Vercel implements via
	// Command.logs) → fromSandboxShell exposes ToolShell.stream → bash variant B.
	const bridged = (chunks: ReadonlyArray<ExecChunk>): Layer.Layer<ToolShell> =>
		fromSandboxShell.pipe(
			Layer.provide(
				Layer.succeed(
					SandboxShell,
					SandboxShell.of({
						exec: () => Effect.die(new Error("exec should not run when streaming")),
						stream: () => Stream.fromIterable(chunks),
					}),
				),
			),
		);

	it("folds backend stdout/stderr chunks into Output and exit into the exit code", async () => {
		const layer = bridged([
			{ _tag: "stdout", bytes: utf8.encode("out\n") },
			{ _tag: "stderr", bytes: utf8.encode("err\n") },
			{ _tag: "exit", exitCode: 0 },
		]);

		const success = await Effect.runPromise(
			bashTool.handler({ command: "x" }, ctx).pipe(Effect.provide(layer), Effect.provide(progressNoop)),
		);

		expect(success.exitCode).toBe(0);
		expect(success.output).toContain("out");
		expect(success.output).toContain("err");
	});
});
