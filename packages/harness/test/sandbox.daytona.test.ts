import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import { Shell } from "../src/sandbox/shell";
import "./utils/env";

const apiKey = process.env.DAYTONA_API_KEY;
const suite = apiKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

// ⚠️ COST / RATE LIMITS — these gated suites provision a REAL Daytona sandbox
// per `runWith` call / per `services({...})` provide, and are subject to the
// account's sandbox quotas and rate limits. Running the file repeatedly in
// quick succession (or alongside other sandbox activity on the same account)
// can trip those limits; failures of that kind are environmental, not test/code
// bugs. See sandbox.vercel.test.ts for the concrete limits we hit on Vercel's
// Hobby plan (10 concurrent, ~40 creations / 10-min window).

// Provision a sandbox with the given provider options, run the program against
// its filesystem + shell, and tear the sandbox down. Each call is one sandbox.
const runWith = <A, E>(
	options: EnvDaytona.Options,
	program: Effect.Effect<A, E, SandboxFileSystem.Service | Shell>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(EnvDaytona.services({ apiKey, ...options }))));

suite("Sandbox.EnvDaytona", () => {
	it(
		"SandboxFileSystem.Service and Shell share the remote Daytona sandbox",
		async () => {
			const dir = `cw-${Date.now()}-remote`;
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;

					yield* Effect.promise(() => filesystem.writeFile(`${dir}/from-service.txt`, "from service"));
					const cat = yield* shell.exec(`cat ${dir}/from-service.txt`);

					const wrote = yield* shell.exec(`echo "from shell" > ${dir}/from-shell.txt`);
					const back = yield* Effect.promise(() => filesystem.readFile(`${dir}/from-shell.txt`));

					const uname = yield* shell.exec("uname -s");
					const node = yield* shell.exec("node --version");

					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/package.json`, "{}"));
					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/.git/config`, ""));
					yield* Effect.promise(() => filesystem.writeFile(`${dir}/workspace/project/package.json`, "{}"));
					const workspace = yield* Effect.promise(() => filesystem.readdir(`${dir}/workspace`));
					const project = yield* Effect.promise(() => filesystem.readdir(`${dir}/workspace/project`));

					return {
						cat,
						wrote,
						back,
						uname,
						node,
						exists: yield* Effect.promise(() => filesystem.exists(`${dir}/from-service.txt`)),
						isDir: yield* Effect.promise(async () => (await filesystem.stat(dir)).isDirectory),
						missing: yield* Effect.promise(() => filesystem.exists(`${dir}/nope.txt`)),
						workspace,
						project,
					};
				}).pipe(Effect.provide(EnvDaytona.services({ apiKey }))),
			);

			expect(result.cat.exitCode).toBe(0);
			expect(result.cat.stdout.trim()).toBe("from service");
			expect(result.wrote.exitCode).toBe(0);
			expect(result.back.trim()).toBe("from shell");
			expect(result.uname.stdout.trim()).toBe("Linux");
			expect(result.node.exitCode).toBe(0);
			expect(result.node.stdout.trim()).toMatch(/^v\d/);
			expect(result.exists).toBe(true);
			expect(result.isDir).toBe(true);
			expect(result.missing).toBe(false);
			expect(result.workspace).toContain(".git");
			expect(result.workspace).toContain("package.json");
			expect(result.workspace).toContain("project");
			expect(result.project).toContain("package.json");
		},
		PROVISION_TIMEOUT,
	);
});

// Provider-specific options must actually take effect inside the sandbox.
//
// Daytona has no fast `runtime` switch like Vercel's node-version test — its
// environment is chosen via `image` / `snapshot`, which trigger a dynamic
// snapshot BUILD (slow, with its own build quota), so a version test is left
// out here to keep the suite fast and reliable. (The default-snapshot node
// version is already asserted by the shared-sandbox test above.) These mirror
// the reliably-testable Vercel custom-option tests: env vars and cwd.
suite("Sandbox.EnvDaytona custom options", () => {
	it(
		"envVars are inherited by commands and per-command env overrides them",
		async () => {
			const result = await runWith(
				{ envVars: { CW_ENV: "from-sandbox" } },
				Effect.gen(function* () {
					const shell = yield* Shell;
					const inherited = yield* shell.exec("echo $CW_ENV");
					const overridden = yield* shell.exec("echo $CW_ENV", { env: { CW_ENV: "from-command" } });
					return { inherited, overridden };
				}),
			);
			expect(result.inherited.exitCode).toBe(0);
			expect(result.inherited.stdout.trim()).toBe("from-sandbox");
			expect(result.overridden.stdout.trim()).toBe("from-command");
		},
		PROVISION_TIMEOUT,
	);

	it(
		"cwd threads into both the shell and relative filesystem ops",
		async () => {
			const marker = `cwd-${Date.now()}.txt`;
			const result = await runWith(
				{ cwd: "/tmp" },
				Effect.gen(function* () {
					const filesystem = yield* SandboxFileSystem.Service;
					const shell = yield* Shell;
					const pwd = yield* shell.exec("pwd");
					// relative write resolves against cwd → /tmp/<marker>
					yield* Effect.promise(() => filesystem.writeFile(marker, "in cwd"));
					// the shell runs in cwd too, so the same relative path reads it back
					const cat = yield* shell.exec(`cat ${marker}`);
					const abs = yield* Effect.promise(() => filesystem.readFile(`/tmp/${marker}`));
					return { pwd: pwd.stdout.trim(), cat: cat.stdout.trim(), abs: abs.trim() };
				}),
			);
			expect(result.pwd).toBe("/tmp");
			expect(result.cat).toBe("in cwd");
			expect(result.abs).toBe("in cwd");
		},
		PROVISION_TIMEOUT,
	);
});
