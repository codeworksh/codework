import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { bashTool } from "../src/plugin/builtin/tool/bash.ts";
import * as Executor from "../src/tool/executor.ts";
import { make as makeProgress } from "../src/tool/progress.ts";
import * as Tool from "../src/tool/tool.ts";
import { pendingCall } from "./tools.fixture.ts";
import { type IToolShell, ToolShell, type ToolShellEvent, ToolShellTimeout } from "../src/tool/shell.ts";

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

const call = (arguments_: Record<string, unknown>) => pendingCall("bash", arguments_, "call-1");

// bash registered with a specific ToolShell backend (provided at registration, per the erasure
// model) → a RegisteredTool the executor runs with no residual tool `R`.
const bashExec = (shell: Layer.Layer<ToolShell>) => Executor.make([Tool.provide(bashTool, shell)]);

describe("bash tool via Executor", () => {
	it("carries truncation + a full-output path on failure too (symmetric with success)", async () => {
		const huge = "x\n".repeat(5_000);
		const layer = stubToolShell(() => Effect.succeed({ stdout: huge, stderr: "", exitCode: 1 }));

		const outcome = await Effect.runPromise(bashExec(layer).handle(call({ command: "x" })));

		expect(outcome.status).toBe("error");
		const details = outcome.result.details as { _tag: string; truncated: boolean; fullOutputPath?: string };
		expect(details._tag).toBe("BashFailed");
		expect(details.truncated).toBe(true);
		expect(details.fullOutputPath).toBeDefined();
	});
});

describe("bash tool error reconciliation (stub backend)", () => {
	it("uses the ToolShellTimeout duration when encoding BashTimedOut details", async () => {
		const layer = stubToolShell((command) => Effect.fail(new ToolShellTimeout({ command, timeoutMillis: 12_500 })));

		const outcome = await Effect.runPromise(bashExec(layer).handle(call({ command: "sleep 100", timeout: 5 })));

		expect(outcome.status).toBe("error");
		expect(outcome.result.details).toMatchObject({ _tag: "BashTimedOut", timeoutSeconds: 12.5 });
	});
});

describe("bash handler in isolation — streaming (variant B)", () => {
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
});
