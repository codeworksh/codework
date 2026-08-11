import { Context, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { type ExecChunk, fromExec, type ISandboxExe, Shell as SandboxShell } from "../src/sandbox/shell/shell.ts";
import { bashTool } from "../src/tools/bash.ts";
import * as Executor from "../src/tools/executor.ts";
import { ToolProgress } from "../src/tools/progress.ts";
import * as Registry from "../src/tools/registry.ts";
import { fromSandboxShell, local, ToolShell, type ToolShellEvent } from "../src/tools/shell.ts";
import * as Tool from "../src/tools/tool.ts";
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

const registerBash = (shell: Layer.Layer<ToolShell>): Tool.RegisteredTool => Tool.provide(bashTool, shell);

describe("ToolRegistry — catalog & snapshot (pure data)", () => {
	it("lists metadata and advertises the wire view", () => {
		const registry = Registry.make([fakeTool("a", "aOut"), fakeTool("b", "bOut")]);

		expect(registry.names).toEqual(["a", "b"]);
		expect(registry.getDef("a")?.description).toBe("returns aOut");
		expect(registry.getDef("missing")).toBeUndefined();
		expect(registry.resolve().wire.map((tool) => tool.name)).toEqual(["a", "b"]);
	});

	it("resolves duplicate names as last-registered-wins for the implementation", () => {
		const registry = Registry.make([fakeTool("a", "v1"), fakeTool("a", "v2")]);

		expect(registry.names).toEqual(["a"]); // one effective entry
		expect(registry.getDef("a")?.description).toBe("returns v2"); // the later impl won
	});

	it("keeps first-seen order for defs/wire/names even when a later entry overrides", () => {
		// [aV1, b, aV2] → names/wire stay ["a", "b"] (a keeps its first-seen slot), impl "a" is aV2.
		const registry = Registry.make([fakeTool("a", "v1"), fakeTool("b", "bOut"), fakeTool("a", "v2")]);
		expect(registry.names).toEqual(["a", "b"]);
		expect(registry.resolve().wire.map((tool) => tool.name)).toEqual(["a", "b"]);
		expect(registry.getDef("a")?.description).toBe("returns v2");
	});

	it("returns a genuinely frozen, stable snapshot", () => {
		const registry = Registry.make([fakeTool("a", "aOut")]);

		expect(Object.isFrozen(registry.names)).toBe(true);
		expect(Object.isFrozen(registry.defs)).toBe(true);
		expect(Object.isFrozen(registry.resolve().wire)).toBe(true);
		expect(registry.resolve()).toBe(registry.resolve()); // same prebuilt snapshot
	});
});

describe("ToolRegistry — execution through the snapshot", () => {
	it("runs the last-registered implementation for an overridden name", async () => {
		const resolved = Registry.make([fakeTool("a", "v1"), fakeTool("a", "v2")]).resolve();
		const outcome = await Effect.runPromise(resolved.handle(pendingCall("a")));

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("v2"); // not "v1"
	});

	it("dispatches by name with first-seen ordering intact", async () => {
		const resolved = Registry.make([fakeTool("a", "v1"), fakeTool("b", "bOut"), fakeTool("a", "v2")]).resolve();

		expect(outputTextOf(await Effect.runPromise(resolved.handle(pendingCall("a"))))).toBe("v2");
		expect(outputTextOf(await Effect.runPromise(resolved.handle(pendingCall("b"))))).toBe("bOut");
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

describe("ToolRegistry — Context.Service variant", () => {
	it("provides the catalog via Layer and resolves + executes through the service", async () => {
		const program = Effect.gen(function* () {
			const registry = yield* Registry.ToolRegistry;
			const outcome = yield* registry.resolve().handle(pendingCall("a"));
			return { names: registry.names, text: outputTextOf(outcome) };
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(Registry.layer([fakeTool("a", "aOut")]))));

		expect(result.names).toEqual(["a"]);
		expect(result.text).toBe("aOut");
	});
});

// ── Bash backend matrix through the registry ────────────────────────────────────────────────

const localOsToolShell = local().pipe(Layer.provide(Sandbox.Process.host));

const justBashToolShell = fromSandboxShell.pipe(Layer.provide(Sandbox.memory()));

const sandboxExecToolShell = (exec: ISandboxExe["exec"]): Layer.Layer<ToolShell> =>
	fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxShell, SandboxShell.of(fromExec({ exec })))));

const sandboxStreamingToolShell = (chunks: ReadonlyArray<ExecChunk>): Layer.Layer<ToolShell> =>
	fromSandboxShell.pipe(
		Layer.provide(
			Layer.succeed(
				SandboxShell,
				SandboxShell.of(
					fromExec({
						exec: () => Effect.die(new Error("exec should not run for a streaming sandbox shell")),
						stream: () => Stream.fromIterable(chunks),
					}),
				),
			),
		),
	);

describe("ToolRegistry — bash backend pluggability", () => {
	it("runs bash over the real local OS ToolShell backend", async () => {
		const resolved = Registry.make([registerBash(localOsToolShell)]).resolve();

		const outcome = await Effect.runPromise(
			resolved.handle(pendingCall("bash", { command: "echo via-local-registry" })),
		);

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("via-local-registry\n");
	});

	it("runs bash over the local just-bash sandbox backend", async () => {
		const resolved = Registry.make([registerBash(justBashToolShell)]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("bash", { command: "echo via-just-bash" })));

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("via-just-bash\n");
	});

	it("runs bash over a Daytona-shaped remote exec-only backend", async () => {
		const daytonaLike = sandboxExecToolShell(() =>
			Effect.succeed({ stdout: "via-daytona\n", stderr: "", exitCode: 0 }),
		);
		const resolved = Registry.make([registerBash(daytonaLike)]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("bash", { command: "ignored by stub" })));

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("via-daytona\n");
	});

	it("runs bash over a Vercel-shaped remote streaming backend", async () => {
		const utf8 = new TextEncoder();
		const vercelLike = sandboxStreamingToolShell([
			{ _tag: "stdout", bytes: utf8.encode("via-vercel\n") },
			{ _tag: "stderr", bytes: utf8.encode("remote-stderr\n") },
			{ _tag: "exit", exitCode: 0 },
		]);
		const resolved = Registry.make([registerBash(vercelLike)]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("bash", { command: "ignored by stub" })));

		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome)).toBe("via-vercel\nremote-stderr\n");
	});
});

// ── Custom tool alongside the built-in: a weather API with real-world latency ────────────────

/** Declared, model-visible failure — the weather analogue of bash's BashFailed. */
class WeatherUnknownCity extends Schema.TaggedError<WeatherUnknownCity>()("WeatherUnknownCity", {
	city: Schema.String,
}) {}

const WeatherParams = Schema.Struct({ city: Schema.String });
const WeatherReport = Schema.Struct({ city: Schema.String, tempC: Schema.Number, sky: Schema.String });

// The remote weather API as a capability service — the custom-tool analogue of bash's
// ToolShell. The tool's handler depends on it via `R`; `Tool.provide` discharges it at
// registration, so the registry composes it with bash without any shared capability union.
class WeatherApi extends Context.Service<
	WeatherApi,
	{ readonly current: (city: string) => Effect.Effect<{ tempC: number; sky: string }, WeatherUnknownCity> }
>()("@codeworksh/harness/test/tools.registry.test/WeatherApi") {}

const weatherDef = Tool.define({
	name: "weather",
	description: "Get the current weather for a city.",
	parameters: WeatherParams,
	success: WeatherReport,
	failure: WeatherUnknownCity,
	failureMode: "return",
	encodeContent: (report) => [{ type: "text", text: `${report.city}: ${report.tempC}°C, ${report.sky}` }],
	encodeFailureContent: (failure) => [{ type: "text", text: `No weather data for "${failure.city}".` }],
});

const weatherHandler: Tool.Handler<
	typeof WeatherParams,
	typeof WeatherReport,
	typeof WeatherUnknownCity,
	WeatherApi
> = (params) =>
	Effect.gen(function* () {
		const api = yield* WeatherApi;
		const report = yield* api.current(params.city);
		return { city: params.city, ...report };
	});

const weatherTool = Tool.implement(weatherDef, weatherHandler);

// Fake remote API: `Effect.sleep` stands in for the network round-trip of a real HTTP request.
const fakeWeatherApi = (latency: Duration.Input): Layer.Layer<WeatherApi> =>
	Layer.succeed(
		WeatherApi,
		WeatherApi.of({
			current: (city) =>
				Effect.sleep(latency).pipe(
					Effect.andThen(
						city === "tokyo"
							? Effect.succeed({ tempC: 21, sky: "clear" })
							: Effect.fail(new WeatherUnknownCity({ city })),
					),
				),
		}),
	);

describe("ToolRegistry — custom weather tool alongside the built-in bash", () => {
	const latency = Duration.millis(80);
	const registerWeather = () => Tool.provide(weatherTool, fakeWeatherApi(latency));

	it("advertises both tools on the wire and dispatches each to its own backend", async () => {
		const resolved = Registry.make([registerBash(justBashToolShell), registerWeather()]).resolve();

		expect(resolved.wire.map((tool) => tool.name)).toEqual(["bash", "weather"]);

		const bashOutcome = await Effect.runPromise(resolved.handle(pendingCall("bash", { command: "echo from-bash" })));
		expect(bashOutcome.status).toBe("completed");
		expect(outputTextOf(bashOutcome)).toBe("from-bash\n");

		const weatherOutcome = await Effect.runPromise(resolved.handle(pendingCall("weather", { city: "tokyo" })));
		expect(weatherOutcome.status).toBe("completed");
		expect(outputTextOf(weatherOutcome)).toBe("tokyo: 21°C, clear");
	});

	it("completes through the mocked API latency (the delay actually elapses)", async () => {
		const resolved = Registry.make([registerWeather()]).resolve();

		const start = Date.now();
		const outcome = await Effect.runPromise(resolved.handle(pendingCall("weather", { city: "tokyo" })));
		const elapsed = Date.now() - start;

		expect(outcome.status).toBe("completed");
		expect(outcome.result.details).toMatchObject({ city: "tokyo", tempC: 21, sky: "clear" });
		expect(elapsed).toBeGreaterThanOrEqual(Duration.toMillis(latency) - 5); // timer jitter tolerance
	});

	it("returns a declared failure as a model-visible error outcome (failureMode: return)", async () => {
		const resolved = Registry.make([registerWeather()]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("weather", { city: "atlantis" })));

		expect(outcome.status).toBe("error");
		expect(outcome.result.isError).toBe(true);
		expect(outputTextOf(outcome)).toBe('No weather data for "atlantis".');
		expect(outcome.result.details).toMatchObject({ _tag: "WeatherUnknownCity", city: "atlantis" });
	});

	it("rejects invalid arguments for the custom tool with an error outcome", async () => {
		const resolved = Registry.make([registerWeather()]).resolve();

		const outcome = await Effect.runPromise(resolved.handle(pendingCall("weather", {}))); // missing `city`

		expect(outcome.status).toBe("error");
		expect(outcome.result.details).toMatchObject({ error: "invalid_arguments", name: "weather" });
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
	it("flushes streamed progress to the sink within the drain grace; outcome is unaffected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codework-registry-"));
		const path = join(dir, "progress.ndjson");
		const resolved = Registry.make([registeredBash]).resolve();

		const outcome = await Effect.runPromise(
			resolved.handle(pendingCall("bash", { command: "echo hi" }), { onProgress }).pipe(
				Effect.provide(fileProgressSink(path)), // only the sink's RProgress remains at run time
			),
		);

		expect(outcome.status).toBe("completed"); // terminal outcome is the source of truth
		const written = (await readFile(path, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { callID: string });
		expect(written.length).toBeGreaterThan(0); // some progress delivered (best-effort)
		expect(written.every((entry) => entry.callID === "call-bash")).toBe(true); // routed to the right call
	});

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

// ── Long-running remote bash: streaming progress to a File IO sink ───────────────────────────
//
// The scenario a live UI cares about: a long-running command on a REMOTE sandbox streams a
// large amount of output (100+ lines), and the user watches it grow via progress events
// flushed to an IO sink (here a temp file; in production a DB / queue / event bus).
//   - Vercel-shaped backend (exec + stream): bash takes the streaming path and reports one
//     cumulative partial per chunk → the sink receives the growing output.
//   - Daytona-shaped backend (exec only): bash takes the buffered path — no progress by
//     design; the full output arrives only in the terminal outcome.

const PROGRESS_LINES = 120;
const progressLine = (i: number) => `progress-line-${i}/${PROGRESS_LINES}`;

// A Vercel-shaped remote streaming backend emitting one stdout chunk per line, spaced out so
// the command is genuinely long-running (~600ms of paced chunks, not one burst) — wide enough
// for the test to observe the sink mid-run.
const CHUNK_SPACING = Duration.millis(5);
const longRunningVercelBackend: Layer.Layer<ToolShell> = fromSandboxShell.pipe(
	Layer.provide(
		Layer.succeed(
			SandboxShell,
			SandboxShell.of(
				fromExec({
					exec: () => Effect.die(new Error("exec should not run for a streaming sandbox shell")),
					stream: () =>
						Stream.fromIterable([
							...Array.from({ length: PROGRESS_LINES }, (_, i): ExecChunk => {
								return { _tag: "stdout", bytes: utf8.encode(`${progressLine(i + 1)}\n`) };
							}),
							{ _tag: "exit", exitCode: 0 } as ExecChunk,
						]).pipe(Stream.schedule(Schedule.spaced(CHUNK_SPACING))),
				}),
			),
		),
	),
);

describe("ToolRegistry — long-running remote bash streams 100+ lines of progress to File IO", () => {
	it("delivers progress LIVE mid-stream, and every event by settlement (Vercel-shaped backend)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codework-registry-"));
		const path = join(dir, "progress.ndjson");
		const resolved = Registry.make([registerBash(longRunningVercelBackend)]).resolve();

		const readEntries = async () =>
			(await readFile(path, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { callID: string; text: string });

		// Run the call WITHOUT awaiting so the sink can be observed while the command streams.
		let settled = false;
		const pending = Effect.runPromise(
			resolved
				.handle(pendingCall("bash", { command: "simulated long-running remote build" }), {
					onProgress,
					// Buffer sized above the event count so the sliding queue drops nothing and the
					// drain grace flushes every event — makes the by-settlement count deterministic.
					progressBuffer: PROGRESS_LINES * 2,
				})
				.pipe(Effect.provide(fileProgressSink(path))),
		).finally(() => {
			settled = true;
		});

		// LIVE delivery: while the command is still streaming, the sink must already hold a
		// genuinely PARTIAL view (fewer lines than the full output). An implementation that
		// buffers progress until completion never produces this state and fails here. The
		// `!settled` recheck after the read guarantees the observation happened mid-run.
		let sawLivePartial = false;
		while (!settled) {
			const last = (await readEntries()).at(-1);
			if (!settled && last !== undefined && last.text.split("\n").filter(Boolean).length < PROGRESS_LINES) {
				sawLivePartial = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(sawLivePartial).toBe(true);

		const outcome = await pending;

		// Terminal outcome carries the complete output (well under the 2000-line truncation).
		expect(outcome.status).toBe("completed");
		const finalText = outputTextOf(outcome);
		expect(finalText).toContain(progressLine(1));
		expect(finalText).toContain(progressLine(PROGRESS_LINES));
		expect(finalText.split("\n").filter(Boolean)).toHaveLength(PROGRESS_LINES);

		// By-settlement delivery — exactly one event per chunk. NOTE: this is NOT the general
		// progress contract (best-effort: the sliding queue may drop intermediates). It is
		// deterministic here only by construction — oversized buffer (240 > 120 events) plus a
		// fast local file sink — so treat it as a narrow implementation check of the lossless
		// configuration, not as delivery semantics.
		const written = await readEntries();
		expect(written).toHaveLength(PROGRESS_LINES);
		expect(written.every((entry) => entry.callID === "call-bash")).toBe(true);

		// Each partial is the CUMULATIVE output so far — what a UI would render live. Delivery
		// is FIFO off the drain fiber, so the text grows monotonically...
		for (let i = 1; i < written.length; i += 1) {
			const prev = written[i - 1];
			const curr = written[i];
			if (prev === undefined || curr === undefined) throw new Error("unreachable: checked length");
			expect(curr.text.length).toBeGreaterThan(prev.text.length);
			expect(curr.text.startsWith(prev.text)).toBe(true);
		}
		// ...from the first line alone to the full 120-line output.
		expect(written[0]?.text).toBe(`${progressLine(1)}\n`);
		expect(written.at(-1)?.text).toBe(finalText);
	});

	it("reports no progress over a Daytona-shaped exec-only backend (buffered path, by design)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codework-registry-"));
		const path = join(dir, "progress.ndjson");
		const fullOutput = Array.from({ length: PROGRESS_LINES }, (_, i) => progressLine(i + 1)).join("\n");
		const daytonaLike = sandboxExecToolShell(() =>
			Effect.succeed({ stdout: `${fullOutput}\n`, stderr: "", exitCode: 0 }),
		);
		const resolved = Registry.make([registerBash(daytonaLike)]).resolve();

		const outcome = await Effect.runPromise(
			resolved
				.handle(pendingCall("bash", { command: "simulated remote build" }), { onProgress })
				.pipe(Effect.provide(fileProgressSink(path))),
		);

		// The full output still arrives — but only in the terminal outcome, with no live view.
		expect(outcome.status).toBe("completed");
		expect(outputTextOf(outcome).split("\n").filter(Boolean)).toHaveLength(PROGRESS_LINES);
		expect(await readFile(path, "utf8").catch(() => "")).toBe(""); // sink never invoked
	});
});
