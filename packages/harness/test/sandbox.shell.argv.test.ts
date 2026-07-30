import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox";
import { fromExec, type ISandboxExe, perMount, quote, quoteArgv, Shell, withCwd } from "../src/sandbox/shell";

// `execArgv` exists so values the harness does not control — branch names, file
// paths — never reach a shell parser as bare text. These cases all break, or
// execute something else entirely, under naive string interpolation.
describe("Shell.execArgv", () => {
	const sandbox = () => Sandbox.memory();

	const withShell = <A, E>(body: (shell: ISandboxExe) => Effect.Effect<A, E, never>) =>
		Effect.runPromise(Effect.flatMap(Shell, body).pipe(Effect.provide(sandbox())));

	const run = (argv: ReadonlyArray<string>) => withShell((shell) => shell.execArgv(argv));

	it("passes an argument containing spaces as one argument", async () => {
		const result = await run(["echo", "two words"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("two words\n");
	});

	it("does not expand a command substitution embedded in an argument", async () => {
		const result = await run(["echo", "$(echo pwned)"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("$(echo pwned)");
	});

	it("does not let a semicolon start a second command", async () => {
		const result = await run(["echo", "a; echo pwned"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("a; echo pwned");
	});

	it("survives embedded single quotes", async () => {
		const result = await run(["echo", `it's "quoted"`]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`it's "quoted"`);
	});

	it("runs in the requested cwd, even one containing a space", async () => {
		const result = await withShell((shell) =>
			Effect.gen(function* () {
				yield* shell.execArgv(["mkdir", "-p", "/work dir"]);
				return yield* shell.execArgv(["pwd"], { cwd: "/work dir" });
			}),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("/work dir");
	});
});

describe("shell quoting helpers", () => {
	it("wraps a value so the shell reads it literally", () => {
		expect(quote("plain")).toBe("'plain'");
		expect(quote("a b")).toBe("'a b'");
		expect(quote("$(x)")).toBe("'$(x)'");
	});

	it("escapes embedded single quotes", () => {
		expect(quote("it's")).toBe(`'it'\\''s'`);
	});

	it("joins a vector into one command string", () => {
		expect(quoteArgv(["git", "checkout", "-B", "feat/a b"])).toBe(`'git' 'checkout' '-B' 'feat/a b'`);
	});
});

// `fromExec` is the fallback every string-only backend uses; it must apply the
// quoting itself rather than trusting the caller.
describe("Shell.fromExec", () => {
	it("quotes the vector before handing it to the string backend", async () => {
		const seen: Array<{ command: string; cwd?: string }> = [];
		const shell = fromExec({
			exec: (command, options) => {
				seen.push({ command, cwd: options?.cwd });
				return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
			},
		});

		await Effect.runPromise(shell.execArgv(["git", "checkout", "a b"]));
		await Effect.runPromise(shell.execArgv(["ls"], { cwd: "/w s" }));

		expect(seen[0]).toEqual({ command: `'git' 'checkout' 'a b'`, cwd: undefined });
		// cwd rides the options rather than a `cd <dir> &&` prefix, which could not
		// tell a failed cd from a failed command — both arrive as one exit code.
		expect(seen[1]).toEqual({ command: `'ls'`, cwd: "/w s" });
	});

	it("preserves a per-mount factory when wrapping a tagged backend", async () => {
		const result = (stdout: string) => Effect.succeed({ stdout, stderr: "", exitCode: 0 });
		const root = fromExec({ exec: () => result("root") });
		const tagged = perMount(root, (cwd) =>
			fromExec({
				exec: (command) => result(`${cwd}:${command}`),
			}),
		);

		const wrapped = fromExec(tagged);
		const mounted = withCwd(wrapped, "/workspace");

		expect((await Effect.runPromise(mounted.execArgv(["echo", "hello"]))).stdout).toBe("/workspace:'echo' 'hello'");
	});
});
