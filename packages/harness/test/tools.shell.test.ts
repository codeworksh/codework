import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type ExecChunk, Shell } from "../src/sandbox/shell/shell.ts";
import { fromSandboxShell, ToolShell } from "../src/tool/shell.ts";

// §8.3: `exec`, `execArgv`, and `stream` all take one options shape, and
// `ToolShell.fromSandboxShell` forwards it. A backend that accepts the shape but
// drops `cwd` is a contract violation — the shell would silently run somewhere
// other than `Current` and the filesystem — so the bridge is asserted against a
// recording stub rather than inferred from the backends that happen to honour it.
describe("ToolShell.fromSandboxShell (options pass-through)", () => {
	const recorder = () => {
		const seen: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
		const record = (command: string, options?: { cwd?: string; env?: Record<string, string> }) => {
			seen.push({
				command,
				...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options?.env === undefined ? {} : { env: options.env }),
			});
		};
		const layer = Layer.succeed(
			Shell,
			Shell.of({
				exec: (command, options) => {
					record(command, options);
					return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
				},
				execArgv: (argv, options) => {
					record(argv.join(" "), options);
					return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
				},
				stream: (command, options) => {
					record(command, options);
					return Stream.succeed<ExecChunk>({ _tag: "exit", exitCode: 0 });
				},
			}),
		);

		return { seen, layer: fromSandboxShell.pipe(Layer.provide(layer)) };
	};

	it("forwards cwd and env through exec", async () => {
		const { seen, layer } = recorder();

		await Effect.runPromise(
			Effect.flatMap(ToolShell, (shell) => shell.exec("pwd", { cwd: "nested", env: { A: "1" } })).pipe(
				Effect.provide(layer),
			),
		);

		expect(seen).toEqual([{ command: "pwd", cwd: "nested", env: { A: "1" } }]);
	});

	it("forwards cwd and env through stream", async () => {
		const { seen, layer } = recorder();

		await Effect.runPromise(
			Effect.flatMap(ToolShell, (shell) =>
				Stream.runDrain(shell.stream!("pwd", { cwd: "/abs", env: { B: "2" } })),
			).pipe(Effect.provide(layer)),
		);

		expect(seen).toEqual([{ command: "pwd", cwd: "/abs", env: { B: "2" } }]);
	});
});
