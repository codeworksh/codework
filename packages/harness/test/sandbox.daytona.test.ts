import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Shell } from "../src/sandbox/shell";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import "./utils/env";

const apiKey = process.env.DAYTONA_API_KEY;
const suite = apiKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

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
