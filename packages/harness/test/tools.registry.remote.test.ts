import { Daytona } from "@daytona/sdk";
import { Effect, Layer, ManagedRuntime } from "effect";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as EnvDaytona from "../src/sandboxes/daytona/provider.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { bashTool } from "../src/tools/bash.ts";
import type * as Executor from "../src/tools/executor.ts";
import * as Registry from "../src/tools/registry.ts";
import { fromSandboxShell, ToolShell } from "../src/tools/shell.ts";
import * as Tool from "../src/tools/tool.ts";
import { labels, makeRemoteOwner } from "./fixtures/remote-owner.ts";
import { pendingCall } from "./tools.fixture.ts";
import "./utils/env.ts";

// Real-backend registry tests: the bash tool registered over an ACTUAL remote sandbox
// (Daytona = buffered exec), executed through `Registry.resolve().handle`
// with live progress flushed to a File IO temp sink. Gated on provider credentials from
// `.env.local` (see ./utils/env) — each suite skips when its key is absent.
//
// The Vercel streaming case lives in sandbox.vercel.test.ts so every Vercel
// contract shares that file's single free-tier resource.

const daytonaKey = process.env.DAYTONA_API_KEY;
const daytonaSuite = daytonaKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

const LINES = 120;
const line = (i: number) => `progress-line-${i}/${LINES}`;
/** Long-running: one line every 20ms → ~2.4s of paced output, so progress arrives over time. */
const BUFFERED_COMMAND = `for i in $(seq 1 ${LINES}); do echo "progress-line-$i/${LINES}"; done`;

interface SinkEntry {
	readonly callID: string;
	readonly text: string;
}

const tempSinkFile = async (): Promise<string> =>
	join(await mkdtemp(join(tmpdir(), "codework-registry-remote-")), "progress.ndjson");

// The File IO progress sink: one NDJSON line per delivered event, carrying the partial's
// cumulative text — exactly what a live UI would render for the user at that moment.
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

const acquireToolShell = <E>(runtime: ManagedRuntime.ManagedRuntime<ToolShell, E>) =>
	runtime.runPromise(
		Effect.gen(function* () {
			return yield* ToolShell;
		}),
	);

// ── Daytona: real remote sandbox, buffered exec path ─────────────────────────────────────────

const makeDaytonaRuntime = (sandboxId: string, instanceId: SandboxInstance.ID) =>
	ManagedRuntime.make(
		Layer.provideMerge(fromSandboxShell, EnvDaytona.services({ apiKey: daytonaKey, sandboxId, instanceId })),
	);

daytonaSuite("ToolRegistry × real Daytona sandbox — buffered bash (no streaming, by design)", () => {
	let runtime!: ReturnType<typeof makeDaytonaRuntime>;
	const owner = makeRemoteOwner("tools.registry.daytona");
	beforeAll(async () => {
		const instanceId = SandboxInstance.ID.create();
		const sdk = new Daytona({ apiKey: daytonaKey });
		const sandbox = await sdk.create({
			language: "typescript",
			autoDeleteInterval: -1,
			labels: labels(instanceId),
		});
		owner.capture(sandbox.id);
		runtime = makeDaytonaRuntime(sandbox.id, instanceId);
	}, PROVISION_TIMEOUT);
	afterAll(
		() =>
			owner.cleanup({
				destroy: async (id) => {
					const sdk = new Daytona({ apiKey: daytonaKey });
					await sdk.delete(await sdk.get(id));
				},
				dispose: () => runtime.dispose(),
			}),
		PROVISION_TIMEOUT,
	);

	it(
		"returns the full 120-line output in the terminal outcome with no progress events",
		async () => {
			const shell = await acquireToolShell(runtime);
			expect(shell.stream).toBeUndefined(); // Daytona backend is exec-only → buffered path
			const resolved = Registry.make([Tool.provide(bashTool, Layer.succeed(ToolShell, shell))]).resolve();
			const path = await tempSinkFile();

			const outcome = await Effect.runPromise(
				resolved.handle(pendingCall("bash", { command: BUFFERED_COMMAND }, "daytona-bash"), {
					onProgress: fileSink(path),
				}),
			);

			// Full output still arrives — but only at completion; the sink is never invoked.
			expect(outcome.status).toBe("completed");
			const finalLines = outputTextOf(outcome).split("\n").filter(Boolean);
			expect(finalLines).toHaveLength(LINES);
			expect(finalLines[0]).toBe(line(1));
			expect(finalLines.at(-1)).toBe(line(LINES));
			expect(await readSink(path)).toHaveLength(0);
		},
		PROVISION_TIMEOUT,
	);
});
