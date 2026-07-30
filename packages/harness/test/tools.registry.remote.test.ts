import { Daytona } from "@daytona/sdk";
import { Sandbox as RemoteSandbox } from "@vercel/sandbox";
import { Effect, Layer, ManagedRuntime } from "effect";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import { EnvVercel } from "../src/sandbox/providers/vercel";
import { SandboxInstance } from "../src/sandbox/instance";
import { bashTool } from "../src/tools/bash";
import type * as Executor from "../src/tools/executor";
import * as Registry from "../src/tools/registry";
import { fromSandboxShell, ToolShell } from "../src/tools/shell";
import * as Tool from "../src/tools/tool";
import { labels, makeRemoteOwner } from "./fixtures/remote-owner";
import { hasLiveOidc } from "./fixtures/vercel";
import { pendingCall } from "./tools.fixture";
import "./utils/env";

// Real-backend registry tests: the bash tool registered over an ACTUAL remote sandbox
// (Vercel = streaming, Daytona = buffered exec), executed through `Registry.resolve().handle`
// with live progress flushed to a File IO temp sink. Gated on provider credentials from
// `.env.local` (see ./utils/env) — each suite skips when its key is absent.
//
// ⚠️ COST / RATE LIMITS — these provision REAL sandboxes. As in sandbox.vercel.test.ts, each
// suite provisions ONE owned resource before attaching its ManagedRuntime (Vercel Hobby caps
// ~40 creations per 10-minute window, 10 concurrent) and tears it down in afterAll.

const vercelToken = process.env.VERCEL_OIDC_TOKEN;
const daytonaKey = process.env.DAYTONA_API_KEY;
const vercelSuite = hasLiveOidc(vercelToken) ? describe : describe.skip;
const daytonaSuite = daytonaKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

const LINES = 120;
const line = (i: number) => `progress-line-${i}/${LINES}`;
/** Long-running: one line every 20ms → ~2.4s of paced output, so progress arrives over time. */
const STREAMING_COMMAND = `for i in $(seq 1 ${LINES}); do echo "progress-line-$i/${LINES}"; sleep 0.02; done`;
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

// ── Vercel: real remote sandbox, streaming path ──────────────────────────────────────────────

const makeVercelRuntime = (sandboxName: string, instanceId: SandboxInstance.ID) =>
	ManagedRuntime.make(Layer.provideMerge(fromSandboxShell, EnvVercel.services({ sandboxName, instanceId })));

vercelSuite("ToolRegistry × real Vercel sandbox — long-running streaming bash + File IO progress", () => {
	let runtime!: ReturnType<typeof makeVercelRuntime>;
	const owner = makeRemoteOwner("tools.registry.vercel");
	beforeAll(async () => {
		const instanceId = SandboxInstance.ID.create();
		const sandbox = await EnvVercel.createSandbox({
			runtime: "node24",
			tags: labels(instanceId),
		});
		owner.capture(sandbox.name);
		runtime = makeVercelRuntime(sandbox.name, instanceId);
	}, PROVISION_TIMEOUT);
	afterAll(
		() =>
			owner.cleanup({
				destroy: async (name) => {
					await (await RemoteSandbox.get({ name, resume: false })).delete();
				},
				dispose: () => runtime.dispose(),
			}),
		PROVISION_TIMEOUT,
	);

	it(
		"streams 100+ lines of live progress from the remote sandbox into the temp-file sink",
		async () => {
			// One shared remote sandbox → a ToolShell instance → discharged into the RegisteredTool.
			const shell = await acquireToolShell(runtime);
			expect(shell.stream).toBeDefined(); // Vercel backend must offer the streaming path
			const resolved = Registry.make([Tool.provide(bashTool, Layer.succeed(ToolShell, shell))]).resolve();
			const path = await tempSinkFile();

			// Run WITHOUT awaiting so the sink can be observed before the call settles.
			let settled = false;
			const pending = Effect.runPromise(
				resolved.handle(
					pendingCall("bash", { command: STREAMING_COMMAND }, "vercel-bash"),
					// Buffer above any plausible chunk count so the sliding queue drops nothing.
					{ onProgress: fileSink(path), progressBuffer: LINES * 2 },
				),
			).finally(() => {
				settled = true;
			});

			// Liveness: at least one progress event must reach the File IO sink BEFORE the terminal
			// outcome. (Provider log chunking is out of our control, so unlike the unit test this
			// does not demand a partial view or an event count — the deterministic mid-stream proof
			// lives in tools.registry.test.ts against a paced fake backend.)
			let sawEntryBeforeSettlement = false;
			while (!settled) {
				const count = (await readSink(path)).length;
				if (!settled && count > 0) {
					sawEntryBeforeSettlement = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(sawEntryBeforeSettlement).toBe(true);

			const outcome = await pending;

			// Terminal outcome — the source of truth: the complete 120-line output, in order.
			expect(outcome.status).toBe("completed");
			const finalText = outputTextOf(outcome);
			const finalLines = finalText.split("\n").filter(Boolean);
			expect(finalLines).toHaveLength(LINES);
			expect(finalLines[0]).toBe(line(1));
			expect(finalLines.at(-1)).toBe(line(LINES));

			// Progress is best-effort and chunking is provider-controlled: require at least one
			// event, and check the growth invariants only over whatever was actually delivered.
			const written = await readSink(path);
			expect(written.length).toBeGreaterThanOrEqual(1);
			expect(written.every((entry) => entry.callID === "vercel-bash")).toBe(true);
			// Every delivered partial is a cumulative snapshot → a prefix of the final output...
			for (const entry of written) {
				expect(finalText.startsWith(entry.text)).toBe(true);
			}
			// ...and when more than one arrives, delivery order shows the output growing.
			for (let i = 1; i < written.length; i += 1) {
				const prev = written[i - 1];
				const curr = written[i];
				if (prev === undefined || curr === undefined) throw new Error("unreachable: checked length");
				expect(curr.text.length).toBeGreaterThan(prev.text.length);
				expect(curr.text.startsWith(prev.text)).toBe(true);
			}
		},
		PROVISION_TIMEOUT,
	);
});

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
