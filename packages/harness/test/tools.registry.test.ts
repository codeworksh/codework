import { Context, Duration, Effect, Layer, Schema, Stream } from "effect";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { bashTool } from "../src/plugin/builtin/tool/bash.ts";
import * as Executor from "../src/tool/executor.ts";
import { ToolProgress } from "../src/tool/progress.ts";
import * as Registry from "../src/tool/registry.ts";
import { ToolShell, type ToolShellEvent } from "../src/tool/shell.ts";
import * as Tool from "../src/tool/tool.ts";
import { pendingCall } from "./tools.fixture.ts";

// A tiny fake tool with no capabilities. Returns a fixed string
// so override/ordering can be proven by *executing*, not just reading metadata.
const fakeTool = (name: string, out: string): Tool.RegisteredTool =>
	Tool.register(
		Tool.make({
			name,
			description: `returns ${out}`,
			parameters: Schema.Struct({}),
			success: Schema.String,
			encodeContent: (value: string) => [{ type: "text", text: value }],
			handler: () => Effect.succeed(out),
		}),
	);

const outputTextOf = (outcome: Executor.ToolOutcome): string => {
	const first = outcome.result.content[0];
	return first && first.type === "text" ? first.text : "";
};

describe("ToolRegistry — execution through the snapshot", () => {
	it("runs the last-registered implementation for an overridden name", async () => {
		const resolved = Registry.make([fakeTool("a", "v1"), fakeTool("a", "v2")]).resolve();
		const outcome = await Effect.runPromise(resolved.handle(pendingCall("a")));

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("v2"); // not "v1"
	});

	it("returns a model-visible error outcome for an unknown tool, not a defect", async () => {
		const resolved = Registry.make([fakeTool("a", "aOut")]).resolve();
		const outcome = await Effect.runPromise(resolved.handle(pendingCall("ghost")));

		expect(outcome.status).toBe("error");
		expect(outcome.result.details).toMatchObject({ error: "unknown_tool", name: "ghost" });
	});

	it("maps an interrupted handler to an aborted outcome carrying the last reported partial", async () => {
		// Reports interim output, then interrupts itself — the executor should surface `aborted`
		// with the last partial (the aborted-call output path), not a defect or a completed result.
		const abortingTool = Tool.register(
			Tool.make({
				name: "abort",
				description: "reports then interrupts",
				parameters: Schema.Struct({}),
				success: Schema.String,
				handler: () =>
					Effect.gen(function* () {
						const progress = yield* ToolProgress;
						yield* progress.report({ content: [{ type: "text", text: "partial-out" }] });
						return yield* Effect.interrupt;
					}),
			}),
		);
		const resolved = Registry.make([abortingTool]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("abort")));

		expect(outcome.status).toBe("aborted");
		expect(outputTextOf(outcome)).toBe("partial-out");
	});
});

// ── Progress delivery via a File IO sink (models any async sink: DB / queue / HTTP) ──────────

const utf8 = new TextEncoder();
const output = (text: string): ToolShellEvent => ({ _tag: "Output", bytes: utf8.encode(text) });
const exited = (exitCode: number): ToolShellEvent => ({ _tag: "Exit", exitCode });

// A streaming ToolShell so bash takes its variant-B path (it reports progress only when streaming).
const streamingToolShell: Layer.Layer<ToolShell> = Layer.succeed(
	ToolShell,
	ToolShell.of({
		exec: () => Effect.die(new Error("exec should not run for the streaming stub")),
		stream: () => Stream.fromIterable([output("chunk-1\n"), output("chunk-2\n"), exited(0)]),
	}),
);

// A progress sink backed by real File IO — a stand-in for any async sink. Its `write` is the
// RProgress capability the observer requires; the observer resolves it from context, so the
// generic RProgress plumbing is exercised end to end.
class FileProgressSink extends Context.Service<
	FileProgressSink,
	{ readonly write: (event: Executor.ProgressEvent) => Effect.Effect<void, Error> }
>()("@codeworksh/harness/test/tools.registry.test/FileProgressSink") {}

const fileProgressSink = (path: string, opts?: { readonly delay?: Duration.Input; readonly fail?: boolean }) =>
	Layer.succeed(
		FileProgressSink,
		FileProgressSink.of({
			write: (event) =>
				Effect.gen(function* () {
					if (opts?.delay !== undefined) yield* Effect.sleep(opts.delay);
					if (opts?.fail) return yield* Effect.fail(new Error("sink down"));
					// One NDJSON line per event: the call it belongs to + the partial's cumulative
					// text — exactly what a live UI would render for the user at that moment.
					const first = event.partial.content?.[0];
					const entry = { callID: event.ctx.callID, text: first?.type === "text" ? first.text : "" };
					yield* Effect.promise(() => appendFile(path, `${JSON.stringify(entry)}\n`));
				}),
		}),
	);

// Observer requires the sink from context → onProgress's RProgress = FileProgressSink.
const onProgress = (event: Executor.ProgressEvent): Effect.Effect<void, Error, FileProgressSink> =>
	Effect.gen(function* () {
		const sink = yield* FileProgressSink;
		yield* sink.write(event);
	});

const registeredBash = Tool.provide(bashTool, streamingToolShell);

describe("ToolRegistry — best-effort progress via a File IO sink", () => {
	it("isolates a failing sink: the tool still completes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codework-registry-"));
		const path = join(dir, "progress.ndjson");
		const resolved = Registry.make([registeredBash]).resolve();

		const outcome = await Effect.runPromise(
			resolved
				.handle(pendingCall("bash", { command: "echo hi" }), { onProgress })
				.pipe(Effect.provide(fileProgressSink(path, { fail: true }))),
		);

		expect(outcome.status).toBe("completed"); // sink failure swallowed, never surfaces
	});

	it("bounds settlement by progressDrainGrace when the sink is slow", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codework-registry-"));
		const path = join(dir, "progress.ndjson");
		const resolved = Registry.make([registeredBash]).resolve();
		const grace = Duration.millis(150);

		const start = Date.now();
		const outcome = await Effect.runPromise(
			resolved
				.handle(pendingCall("bash", { command: "echo hi" }), { onProgress, progressDrainGrace: grace })
				.pipe(Effect.provide(fileProgressSink(path, { delay: Duration.seconds(5) }))),
		);
		const elapsed = Date.now() - start;

		expect(outcome.status).toBe("completed");
		// Bounded by the grace — nowhere near the 5s sink delay.
		expect(elapsed).toBeLessThan(3_000);
	});
});
