import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
	type ExecResult,
	fromExec,
	type ISandboxExe,
	quoteArgv,
	resolveCwd,
	type ShellOptions,
	withCwd,
} from "../src/sandbox/shell";

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

	it("passes environment through unchanged while resolving cwd", async () => {
		const { backend, calls } = recording();
		const mounted = withCwd(backend, "/mount");

		await Effect.runPromise(mounted.exec("env", { env: { MARKER: "kept" }, cwd: "rel" }));

		expect(calls[0]!.options).toEqual({ env: { MARKER: "kept" }, cwd: "/mount/rel" });
	});

	it("omits stream when the backend has none", () => {
		const { backend } = recording();
		const { stream: _stream, ...withoutStream } = backend;

		const mounted = withCwd(withoutStream, "/mount");

		expect(mounted.stream).toBeUndefined();
		expect("stream" in mounted).toBe(false);
	});
});

describe("Shell.fromExec", () => {
	it("completes a string-only backend by quoting the vector through exec", async () => {
		const { backend, calls } = recording();
		const { execArgv: _execArgv, stream: _stream, ...execOnly } = backend;

		const completed = fromExec(execOnly);
		await Effect.runPromise(completed.execArgv(["printf", "%s", "a b;$(echo pwned)"], { cwd: "/mount" }));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.entry).toBe("exec");
		expect(calls[0]!.command).toBe(quoteArgv(["printf", "%s", "a b;$(echo pwned)"]));
		expect(calls[0]!.options?.cwd).toBe("/mount");
	});

	it("carries a backend's stream implementation through unchanged", () => {
		const { backend } = recording();
		const { execArgv: _execArgv, ...execAndStream } = backend;

		const completed = fromExec(execAndStream);

		expect(completed.stream).toBe(backend.stream);
	});
});

describe("Shell.resolveCwd", () => {
	it("resolves a relative operation cwd against the base and leaves the rest alone", () => {
		expect(resolveCwd(undefined, undefined)).toBeUndefined();
		expect(resolveCwd("/mount", undefined)).toBe("/mount");
		expect(resolveCwd("/mount", "nested")).toBe("/mount/nested");
		expect(resolveCwd("/mount", "/absolute")).toBe("/absolute");
		// no base to resolve against: the relative value passes through
		expect(resolveCwd(undefined, "relative")).toBe("relative");
	});
});
