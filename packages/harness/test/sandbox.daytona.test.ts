import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { Shell } from "../src/sandbox/adapter";
import { EnvBash } from "../src/sandbox/justbashexe";
import { EnvDaytona } from "../src/sandbox/providers/daytona";
import "./utils/env";

// Daytona is a real remote sandbox: these tests provision a cloud box, so they
// only run when DAYTONA_API_KEY is present (loaded from .env.local)
// sandbox. The provider has no synchronous I/O / cwd, so paths are absolute
// (under /tmp, always writable).
const apiKey = process.env.DAYTONA_API_KEY;
const suite = apiKey ? describe : describe.skip;

const PROVISION_TIMEOUT = 180_000;

suite("Sandbox.EnvDaytona", () => {
	// Daytona as a vfs provider + its own native shell: FileSystem.Service and
	// the Shell operate on the same remote tree, and the shell runs real
	// binaries (here, the sandbox's node) — not emulated coreutils.
	it(
		"FileSystem.Service and the native shell share the remote tree",
		async () => {
			const dir = `/tmp/cw-${Date.now()}-native`;
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* Shell;

					// shell sees what the service wrote
					yield* filesystem.writeFileString(`${dir}/from-service.txt`, "from service");
					const cat = yield* shell.exec(`cat ${dir}/from-service.txt`);

					// service sees what the shell wrote
					const wrote = yield* shell.exec(`echo "from shell" > ${dir}/from-shell.txt`);
					const back = yield* filesystem.readFileString(`${dir}/from-shell.txt`);

					// the native shell runs the sandbox's real binaries
					const uname = yield* shell.exec("uname -s");
					const node = yield* shell.exec("node --version");

					return {
						cat,
						wrote,
						back,
						uname,
						node,
						exists: yield* filesystem.exists(`${dir}/from-service.txt`),
						isDir: yield* filesystem.isDir(dir),
						missing: yield* filesystem.exists(`${dir}/nope.txt`),
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
		},
		PROVISION_TIMEOUT,
	);

	// The very same Daytona vfs, driven by in-process just-bash instead of the
	// native shell: emulated coreutils read/write the remote tree, but real
	// binaries (git) are not built in.
	it(
		"runs in-process just-bash over the Daytona vfs (coreutils only)",
		async () => {
			const dir = `/tmp/cw-${Date.now()}-justbash`;
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* Shell;

					yield* filesystem.writeFileString(`${dir}/jb.txt`, "from service");
					const cat = yield* shell.exec(`cat ${dir}/jb.txt`);
					const piped = yield* shell.exec("printf 'a\\nb\\na\\n' | sort | uniq | wc -l");
					const wrote = yield* shell.exec(`echo hi > ${dir}/jb-out.txt`);
					const back = yield* filesystem.readFileString(`${dir}/jb-out.txt`);

					// git is not a just-bash built-in — for real binaries use the native shell
					const git = yield* shell.exec("git --version");

					return { cat, piped, wrote, back, git };
				}).pipe(Effect.provide(EnvBash.services(EnvDaytona.vfs({ apiKey })))),
			);

			expect(result.cat.exitCode).toBe(0);
			expect(result.cat.stdout.trim()).toBe("from service");
			expect(result.piped.stdout.trim()).toBe("2");
			expect(result.wrote.exitCode).toBe(0);
			expect(result.back.trim()).toBe("hi");
			expect(result.git.exitCode).not.toBe(0);
		},
		PROVISION_TIMEOUT,
	);
});
