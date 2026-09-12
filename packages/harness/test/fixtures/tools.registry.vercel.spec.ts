import { fileSink, readSink, outputTextOf } from "./progress.ts";
import { tmpdir } from "./tempdir.ts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxInstance } from "../../src/sandbox/instance.ts";
import * as EnvVercel from "../../src/sandboxes/vercel/provider.ts";
import { bashTool } from "../../src/plugin/internal/tool/bash.ts";
import * as Registry from "../../src/tool/registry.ts";
import { fromSandboxShell, ToolShell } from "../../src/tool/shell.ts";
import * as Tool from "../../src/tool/tool.ts";
import { pendingCall } from "../tools.fixture.ts";

// Uses the Vercel sandbox owned by sandbox.vercel.e2e.test.ts; never provisions one.
const PROVISION_TIMEOUT = 180_000;
const LINES = 120;
const line = (index: number) => `progress-line-${index}/${LINES}`;
const STREAMING_COMMAND = `for i in $(seq 1 ${LINES}); do echo "progress-line-$i/${LINES}"; sleep 0.02; done`;

const makeRuntime = (sandboxName: string, instanceId: SandboxInstance.ID) =>
	ManagedRuntime.make(Layer.provideMerge(fromSandboxShell, EnvVercel.services({ sandboxName, instanceId })));

/** Registers the real-tool check against the Vercel resource owned by the parent suite. */
export const toolsRegistryVercelSpec = (resourceId: () => Promise<string>) =>
	describe("ToolRegistry × shared Vercel sandbox", () => {
		let runtime!: ReturnType<typeof makeRuntime>;

		beforeAll(async () => {
			runtime = makeRuntime(await resourceId(), SandboxInstance.ID.create());
		}, PROVISION_TIMEOUT);
		afterAll(() => runtime?.dispose() ?? Promise.resolve(), PROVISION_TIMEOUT);

		it(
			"streams 100+ lines of live progress into the temp-file sink",
			async () => {
				const shell = await runtime.runPromise(Effect.flatMap(ToolShell, Effect.succeed));
				expect(shell.stream).toBeDefined();
				const resolved = Registry.make([Tool.provide(bashTool, Layer.succeed(ToolShell, shell))]).resolve();
				await using temp = await tmpdir();
				const path = join(temp.path, "progress.ndjson");

				const abort = new AbortController();
				let settled = false;
				const pending = Effect.runPromise(
					resolved
						.handle(pendingCall("bash", { command: STREAMING_COMMAND }, "vercel-bash"), {
							onProgress: fileSink(path),
							progressBuffer: LINES * 2,
						})
						.pipe(Effect.timeout("30 seconds")),
					{ signal: abort.signal },
				).finally(() => {
					settled = true;
				});

				// Observe rejection immediately; the awaited result below still fails the test.
				void pending.catch(() => undefined);
				try {
					let sawEntryBeforeSettlement = false;
					while (!settled) {
						const entries = await readSink(path);
						if (!settled && entries.length > 0) {
							sawEntryBeforeSettlement = true;
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					const outcome = await pending;
					expect(sawEntryBeforeSettlement).toBe(true);
					expect(outcome.status).toBe("completed");
					const finalText = outputTextOf(outcome);
					const finalLines = finalText.split("\n").filter(Boolean);
					expect(finalLines).toHaveLength(LINES);
					expect(finalLines).toEqual(Array.from({ length: LINES }, (_, index) => line(index + 1)));

					const written = await readSink(path);
					expect(written.length).toBeGreaterThanOrEqual(1);
					expect(written.every((entry) => entry.callID === "vercel-bash")).toBe(true);
					for (const entry of written) expect(finalText.startsWith(entry.text)).toBe(true);
					for (let index = 1; index < written.length; index += 1) {
						const previous = written[index - 1];
						const current = written[index];
						if (previous === undefined || current === undefined) throw new Error("unreachable: checked length");
						expect(current.text.length).toBeGreaterThan(previous.text.length);
						expect(current.text.startsWith(previous.text)).toBe(true);
					}
				} finally {
					abort.abort();
					await pending.catch(() => undefined);
				}
			},
			PROVISION_TIMEOUT,
		);
	});
