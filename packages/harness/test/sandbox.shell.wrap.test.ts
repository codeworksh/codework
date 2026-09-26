import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type ExecResult, type ISandboxExe, type ShellOptions, withCwd } from "../src/sandbox/shell/shell.ts";

/**
 * The cwd wrapper is the contract §8 rests on: `exec`, `execArgv`, and `stream`
 * all receive the mount cwd unless an operation overrides it, and a relative
 * override resolves against the mount. The streaming entry point only exists on
 * remote backends, so it is pinned here against a recording fake rather than
 * behind provider credentials.
 */

interface Call {
	readonly entry: "exec" | "execArgv" | "stream";
	readonly command: string;
	readonly options: ShellOptions | undefined;
}

const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

const recording = () => {
	const calls: Call[] = [];
	const backend: ISandboxExe = {
		exec: (command, options) => {
			calls.push({ entry: "exec", command, options });
			return Effect.succeed(ok);
		},
		execArgv: (argv, options) => {
			calls.push({ entry: "execArgv", command: argv.join(" "), options });
			return Effect.succeed(ok);
		},
		stream: (command, options) => {
			calls.push({ entry: "stream", command, options });
			return Stream.empty;
		},
	};
	return { backend, calls };
};

describe("Shell.withCwd", () => {
	it("binds the mount cwd to exec, execArgv, and stream", async () => {
		const { backend, calls } = recording();
		const mounted = withCwd(backend, "/mount");

		await Effect.runPromise(mounted.exec("pwd"));
		await Effect.runPromise(mounted.execArgv(["pwd"]));
		mounted.stream!("pwd");

		expect(calls.map((call) => call.options?.cwd)).toEqual(["/mount", "/mount", "/mount"]);
	});

	it("lets an operation override the mount cwd, absolutely or relatively", async () => {
		const { backend, calls } = recording();
		const mounted = withCwd(backend, "/mount");

		await Effect.runPromise(mounted.exec("pwd", { cwd: "/elsewhere" }));
		await Effect.runPromise(mounted.execArgv(["pwd"], { cwd: "nested" }));
		mounted.stream!("pwd", { cwd: "nested/deeper" });

		expect(calls.map((call) => call.options?.cwd)).toEqual(["/elsewhere", "/mount/nested", "/mount/nested/deeper"]);
	});
});
