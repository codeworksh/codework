import { Effect, Layer, ManagedRuntime } from "effect";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxInstance } from "../../src/sandbox/instance.ts";
import * as EnvVercel from "../../src/sandboxes/vercel/provider.ts";
import { bashTool } from "../../src/tools/bash.ts";
import type * as Executor from "../../src/tools/executor.ts";
import * as Registry from "../../src/tools/registry.ts";
import { fromSandboxShell, ToolShell } from "../../src/tools/shell.ts";
import * as Tool from "../../src/tools/tool.ts";
import { pendingCall } from "../tools.fixture.ts";

// Uses the Vercel sandbox owned by sandbox.vercel.test.ts; never provisions one.
const PROVISION_TIMEOUT = 180_000;
const LINES = 120;
const line = (index: number) => `progress-line-${index}/${LINES}`;
const STREAMING_COMMAND = `for i in $(seq 1 ${LINES}); do echo "progress-line-$i/${LINES}"; sleep 0.02; done`;

interface SinkEntry {
	readonly callID: string;
	readonly text: string;
}

const tempSinkFile = async (): Promise<string> =>
	join(await mkdtemp(join(tmpdir(), "codework-registry-vercel-")), "progress.ndjson");

const fileSink =
	(path: string) =>
	(event: Executor.ProgressEvent): Effect.Effect<void> =>
		Effect.promise(() => {
			const first = event.partial.content?.[0];
			const entry: SinkEntry = { callID: event.ctx.callID, text: first?.type === "text" ? first.text : "" };
			return appendFile(path, `${JSON.stringify(entry)}\n`);
		});

const readSink = async (path: string): Promise<SinkEntry[]> =>
	(await readFile(path, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((raw) => JSON.parse(raw) as SinkEntry);

const outputTextOf = (outcome: Executor.ToolOutcome): string => {
	const first = outcome.result.content[0];
	return first && first.type === "text" ? first.text : "";
};

const makeRuntime = (sandboxName: string, instanceId: SandboxInstance.ID) =>
	ManagedRuntime.make(Layer.provideMerge(fromSandboxShell, EnvVercel.services({ sandboxName, instanceId })));

/** Registers the real-tool check against the Vercel resource owned by the parent suite. */
export const toolsRegistryVercelSpec = (resourceId: () => Promise<string>) =>
	describe("ToolRegistry × shared Vercel sandbox", () => {
		let runtime!: ReturnType<typeof makeRuntime>;

		beforeAll(async () => {
			runtime = makeRuntime(await resourceId(), SandboxInstance.ID.create());
		}, PROVISION_TIMEOUT);
		afterAll(() => runtime.dispose(), PROVISION_TIMEOUT);

		it(
			"streams 100+ lines of live progress into the temp-file sink",
			async () => {
				const shell = await runtime.runPromise(Effect.flatMap(ToolShell, Effect.succeed));
				expect(shell.stream).toBeDefined();
				const resolved = Registry.make([Tool.provide(bashTool, Layer.succeed(ToolShell, shell))]).resolve();
				const path = await tempSinkFile();

				let settled = false;
				const pending = Effect.runPromise(
					resolved.handle(pendingCall("bash", { command: STREAMING_COMMAND }, "vercel-bash"), {
						onProgress: fileSink(path),
						progressBuffer: LINES * 2,
					}),
				).finally(() => {
					settled = true;
				});

				let sawEntryBeforeSettlement = false;
				while (!settled) {
					if (!settled && (await readSink(path)).length > 0) {
						sawEntryBeforeSettlement = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(sawEntryBeforeSettlement).toBe(true);

				const outcome = await pending;
				expect(outcome.status).toBe("completed");
				const finalText = outputTextOf(outcome);
				const finalLines = finalText.split("\n").filter(Boolean);
				expect(finalLines).toHaveLength(LINES);
				expect(finalLines[0]).toBe(line(1));
				expect(finalLines.at(-1)).toBe(line(LINES));

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
			},
			PROVISION_TIMEOUT,
		);
	});
