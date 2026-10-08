import { Effect, Fiber, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import fs from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { bashTool } from "../src/plugin/builtin/tool/bash.ts";
import { EnvNodeJSDefault } from "../src/sandbox/fs/nodejs.ts";
import { Local } from "../src/sandbox/fs/vfs.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { HostExe } from "../src/sandbox/shell/host.ts";
import { Shell } from "../src/sandbox/shell/shell.ts";
import * as Executor from "../src/tool/executor.ts";
import { fromSandboxShell, ToolShell } from "../src/tool/shell.ts";
import * as Tool from "../src/tool/tool.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * The bash tool end to end over two real backends — the host shell, which
 * streams, and just-bash, which returns output at the end — with its output file
 * written inside the sandbox. Ways it could go wrong, each a case below:
 *   - small output leaves a file behind, or large output keeps none
 *   - the kept file is not the complete output, or is readable by others
 *   - the shown tail or its line numbers are wrong once the start was skipped
 *   - the wrapper changes the command: its exit code, `exit`, a `)` in a comment
 *   - output produced before a deadline is lost, or the deadline leaves files behind
 *   - background jobs still writing when the command returns lose their output
 *   - a huge final line shows as nothing
 *   - output that decodes larger than it is (invalid UTF-8) is cut without saying so
 *   - a trailing NUL makes the sandbox and the harness count lines differently
 *   - a child that outlives its parent survives the deadline
 */

interface Details {
	readonly _tag?: string;
	readonly output: string;
	readonly truncated: boolean;
	readonly fullOutputPath?: string;
	readonly exitCode?: number;
}

// The host shell without `stream`: the buffered wrapper under a real `sh`, which
// unlike just-bash runs background jobs and writes raw bytes.
const withoutStream = Layer.effect(
	Shell,
	Effect.map(Shell, (shell) => Shell.of({ exec: shell.exec, execArgv: shell.execArgv })),
).pipe(Layer.provide(HostExe.layer()));

const host = (cwd: string, shell: Layer.Layer<Shell, never, ChildProcessSpawner.ChildProcessSpawner>) =>
	SandboxIO.mount(SandboxIO.host(cwd)).pipe(
		Layer.provide(Layer.provideMerge(Layer.merge(Local.layer, shell), EnvNodeJSDefault.layer())),
	);

const backends = {
	host: (cwd: string) => host(cwd, HostExe.layer()),
	hostBuffered: (cwd: string) => host(cwd, withoutStream),
	justbash: () => Sandbox.EnvBash.services(Sandbox.EnvInMemory.layer(), SandboxIO.virtual({ driver: "memory" })),
};

const call = <E>(mount: Layer.Layer<SandboxIO.Provides, E>, command: string, timeout?: number) =>
	Effect.gen(function* () {
		const filesystem = yield* SandboxIO.FileSystem;
		const tool = Tool.provide(
			bashTool,
			Layer.merge(
				fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxIO.Shell, yield* SandboxIO.Shell))),
				Layer.succeed(SandboxIO.Current, yield* SandboxIO.Current),
			),
		);
		const outcome = yield* Executor.make([tool]).handle(
			pendingCall("bash", { command, ...(timeout === undefined ? {} : { timeout }) }, "call-1"),
		);
		const details = outcome.result.details as Details;
		const saved = details.fullOutputPath;
		const spilled =
			saved === undefined
				? undefined
				: {
						content: yield* filesystem.readFile(saved),
						leftovers: (yield* filesystem.readdir("/tmp")).filter((name) => name.endsWith(".rc")),
					};
		return { status: outcome.status, details, spilled };
	}).pipe(Effect.provide(mount));

const run = <E>(mount: Layer.Layer<SandboxIO.Provides, E>, command: string, timeout?: number) =>
	Effect.runPromise(call(mount, command, timeout));

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `${index + 1}\n`).join("");

describe.each([
	["host", "streams"],
	["hostBuffered", "buffers"],
	["justbash", "buffers"],
] as const)("bash output files over %s (%s)", (backend, _mode) => {
	const mount = async () => {
		const dir = await tmpdir();
		return { dir, layer: backend === "justbash" ? backends.justbash() : backends[backend](dir.path) };
	};

	it("keeps no file for output within the limits", async () => {
		const { dir, layer } = await mount();
		await using _ = dir;
		const before = backend !== "justbash" ? await fs.readdir("/tmp") : [];
		const result = await run(layer, "echo small; echo 'a ) in a comment' # )");
		expect(result.status).toBe("completed");
		expect(result.details).toMatchObject({ output: "small\na ) in a comment\n", truncated: false, exitCode: 0 });
		expect(result.details.fullOutputPath).toBeUndefined();
		if (backend !== "justbash") {
			const added = (await fs.readdir("/tmp")).filter(
				(name) => !before.includes(name) && name.startsWith("codework-bash"),
			);
			expect(added).toEqual([]);
		}
	});

	it("keeps the complete output in the sandbox and shows its tail", async () => {
		const { dir, layer } = await mount();
		await using _ = dir;
		const result = await run(layer, "seq 1 2500; echo héllo; exit 3");
		expect(result.status).toBe("error");
		expect(result.details).toMatchObject({ _tag: "BashFailed", exitCode: 3, truncated: true });
		expect(result.spilled?.content).toBe(`${numbered(2500)}héllo\n`);
		expect(result.spilled?.leftovers).toEqual([]);
		expect(result.details.output.startsWith("502\n")).toBe(true);
		expect(result.details.output).toContain(
			`héllo\n\n[showing lines 502-2501 of 2501. Full output: ${result.details.fullOutputPath}]`,
		);
		if (backend !== "justbash") expect((await fs.stat(result.details.fullOutputPath!)).mode & 0o777).toBe(0o600);
		if (backend !== "justbash") await fs.rm(result.details.fullOutputPath!);
	});

	it("waits for background jobs still writing", async () => {
		const { dir, layer } = await mount();
		await using _ = dir;
		const result = await run(layer, "(sleep 0.3; echo late) & echo héllo");
		// just-bash runs a background job to completion first, so only the content is compared.
		expect(result.details.output.split("\n").sort()).toEqual(["", "héllo", "late"]);
	});

	// just-bash's awk ignores a printf width and writes "\377" as valid UTF-8, so these need a real shell.
	if (backend !== "justbash")
		it("shows the end of a huge final line", async () => {
			const { dir, layer } = await mount();
			await using _ = dir;
			const result = await run(layer, `awk 'BEGIN { s = sprintf("%300000s", ""); gsub(/ /, "x", s); print s }'`);
			expect(result.details.truncated).toBe(true);
			expect(result.details.output).toMatch(/^x{51200}\n\n\[showing last 50\.0KB of line 1/);
			await fs.rm(result.details.fullOutputPath!);
		});

	if (backend !== "justbash")
		it("says it cut output that decodes larger than it is, without a file it removed", async () => {
			const { dir, layer } = await mount();
			await using _ = dir;
			const result = await run(layer, `awk 'BEGIN { for (i = 0; i < 20000; i++) printf "\\377" }'`);
			expect(result.details.truncated).toBe(true);
			expect(result.details.fullOutputPath).toBeUndefined();
		});

	it("counts a final line that ends in NUL the way the sandbox does", async () => {
		const { dir, layer } = await mount();
		await using _ = dir;
		const result = await run(layer, `seq 1 2000; printf '\\000'`);
		expect(result.details.truncated).toBe(true);
		expect(result.spilled?.content).toBe(`${numbered(2000)}\0`);
		if (backend !== "justbash") await fs.rm(result.details.fullOutputPath!);
	});

	if (backend !== "justbash")
		it("leaves no files when the call is cancelled", async () => {
			const { dir, layer } = await mount();
			await using _ = dir;
			const before = await fs.readdir("/tmp");
			await Effect.runPromise(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(call(layer, "echo partial; sleep 5"));
					yield* Effect.sleep("500 millis");
					yield* Fiber.interrupt(fiber);
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const added = (await fs.readdir("/tmp")).filter(
				(name) => !before.includes(name) && name.startsWith("codework-bash"),
			);
			expect(added).toEqual([]);
		});

	if (backend === "host") {
		it("keeps output produced before a deadline, and no files", async () => {
			const { dir, layer } = await mount();
			await using _ = dir;
			const before = await fs.readdir("/tmp");
			const result = await run(layer, "echo partial-line; sleep 5", 2);
			expect(result.status).toBe("error");
			expect(result.details).toMatchObject({ _tag: "BashTimedOut", truncated: false });
			expect(result.details.output).toContain("partial-line");
			const added = (await fs.readdir("/tmp")).filter(
				(name) => !before.includes(name) && name.startsWith("codework-bash"),
			);
			expect(added).toEqual([]);
		});

		it("kills a child that outlives its parent at the deadline", async () => {
			const { dir, layer } = await mount();
			await using _ = dir;
			const result = await run(layer, `sh -c 'trap "" TERM; exec sleep 30' & echo "child $!"`, 1);
			const pid = Number(/child (\d+)/.exec(result.details.output)?.[1]);
			expect(pid).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(() => process.kill(pid, 0)).toThrow();
		});
	}
});

describe("ToolShell over the host sandbox shell", () => {
	it("force-kills a command that ignores SIGTERM at its deadline", async () => {
		await using dir = await tmpdir();
		const started = Date.now();
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* ToolShell;
				return yield* shell.exec("trap '' TERM; sleep 5", { timeout: "100 millis" });
			}).pipe(Effect.provide(fromSandboxShell.pipe(Layer.provide(backends.host(dir.path)))), Effect.flip),
		);
		expect(error._tag).toBe("ToolShellTimeout");
		expect(Date.now() - started).toBeLessThan(2_500);
	});
});
