import { Effect, Layer } from "effect";
import { realpath } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EnvInMemory } from "../src/sandbox/fs/inmemory.ts";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { EnvNodeJSDefault } from "../src/sandbox/fs/nodejs.ts";
import { Local } from "../src/sandbox/fs/vfs.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { HostExe } from "../src/sandbox/shell/host.ts";
import { EnvBash } from "../src/sandbox/shell/justbash.ts";
import { Shell } from "../src/sandbox/shell/shell.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

/**
 * A mount is a filesystem, a shell, and the directory they act on. The property
 * this file exists for is that the directory belongs to the *mount* and not to
 * the transport beneath it, so two mounts of one namespace can sit in different
 * directories at the same time — the normal case the moment two sessions work in
 * two repositories on the same machine.
 */

// One transport, built once. Both mounts below are layered over this same value,
// which is what makes the isolation claim meaningful: if the directory lived in
// here, the second mount would either see the first's or move it.
const transport = Layer.provideMerge(Layer.merge(Local.layer, HostExe.layer()), EnvNodeJSDefault.layer());

const at = <A, E>(cwd: string, program: Effect.Effect<A, E, SandboxIO.Provides>) =>
	Effect.provide(program, SandboxIO.mount(SandboxIO.host(cwd)));

describe("SandboxIO.mount", () => {
	it("keeps two host mounts at different working directories independent", async () => {
		await using tmp = await tmpdir();
		// macOS resolves /var through a symlink, and `pwd` reports it resolved.
		const root = await realpath(tmp.path);
		const alpha = path.join(root, "alpha");
		const beta = path.join(root, "beta");
		await fs.mkdir(alpha);
		await fs.mkdir(beta);

		// Each mount writes to the *same relative path* and runs `pwd`.
		const work = Effect.gen(function* () {
			const filesystem = yield* SandboxFileSystem.Service;
			const shell = yield* Shell;
			const current = yield* SandboxIO.Current;
			yield* filesystem.writeFile("marker.txt", current.cwd);
			return {
				cwd: current.cwd,
				pwd: (yield* shell.exec("pwd")).stdout.trim(),
			};
		});

		const [first, second] = await Effect.runPromise(
			Effect.all([at(alpha, work), at(beta, work)]).pipe(Effect.provide(transport)),
		);

		expect(first!.cwd).toBe(alpha);
		expect(second!.cwd).toBe(beta);
		// the shell agrees with the filesystem about where it is
		expect(first!.pwd).toBe(alpha);
		expect(second!.pwd).toBe(beta);

		// one relative path, two files, neither mount having moved the other
		expect(await fs.readFile(path.join(alpha, "marker.txt"), "utf8")).toBe(alpha);
		expect(await fs.readFile(path.join(beta, "marker.txt"), "utf8")).toBe(beta);
	});

	it("does not let an override leak into the next operation", async () => {
		await using tmp = await tmpdir();
		const root = await realpath(tmp.path);
		const alpha = path.join(root, "alpha");
		await fs.mkdir(alpha);

		const result = await Effect.runPromise(
			at(
				alpha,
				Effect.gen(function* () {
					const shell = yield* Shell;
					yield* shell.exec("pwd", { cwd: root });
					// the override was for that call only — nothing mutated shared state
					return (yield* shell.exec("pwd")).stdout.trim();
				}),
			).pipe(Effect.provide(transport)),
		);

		expect(result).toBe(alpha);
	});
});

// The host proves the property over a real filesystem; this proves it over a
// shared VFS, which is where the original defect lived — `chdir` on a virtual
// filesystem is one piece of global state, so a per-mount directory is the only
// thing that lets two mounts of one namespace disagree about where they are.
describe("SandboxIO.mount over a shared virtual filesystem", () => {
	it("keeps two mounts of one VFS at different working directories independent", async () => {
		// One in-memory VFS and one mountable shell transport, two mounts over
		// them. Each mount constructs its own just-bash interpreter, matching
		// Flue's BashFactory-per-session ownership.
		// `Sandbox.memory()` builds a fresh VFS per call, which is the case that
		// cannot show anything.
		const primitives = EnvInMemory.layer({ cwd: "/alpha" });
		const transport = Layer.provideMerge(Layer.merge(Local.layer, EnvBash.transport(primitives)), primitives);

		const work = Effect.gen(function* () {
			const filesystem = yield* SandboxFileSystem.Service;
			const shell = yield* Shell;
			const current = yield* SandboxIO.Current;
			yield* filesystem.writeFile("marker.txt", current.cwd);
			return { cwd: current.cwd, pwd: (yield* shell.exec("pwd")).stdout.trim() };
		});

		const at = (cwd: string) =>
			Effect.provide(work, SandboxIO.mount(SandboxIO.virtual({ driver: "memory", defaultCwd: "/", cwd })));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				yield* filesystem.mkdir("/beta", { recursive: true });
				const [first, second] = yield* Effect.all([at("/alpha"), at("/beta")]);
				return {
					first,
					second,
					alpha: yield* filesystem.readFile("/alpha/marker.txt"),
					beta: yield* filesystem.readFile("/beta/marker.txt"),
				};
			}).pipe(Effect.provide(transport)),
		);

		expect(result.first).toEqual({ cwd: "/alpha", pwd: "/alpha" });
		expect(result.second).toEqual({ cwd: "/beta", pwd: "/beta" });
		// one relative path, two files, neither mount having moved the other
		expect(result.alpha).toBe("/alpha");
		expect(result.beta).toBe("/beta");
	});

	it("keeps stateful just-bash internals local to each mount", async () => {
		const primitives = EnvInMemory.layer({ cwd: "/alpha" });
		const transport = Layer.provideMerge(Layer.merge(Local.layer, EnvBash.transport(primitives)), primitives);
		const marker = "mount_alpha_only";

		const at = <A, E>(cwd: string, program: Effect.Effect<A, E, Shell>) =>
			Effect.provide(program, SandboxIO.mount(SandboxIO.virtual({ driver: "memory", defaultCwd: "/", cwd })));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				yield* filesystem.mkdir("/beta", { recursive: true });

				const alpha = yield* at(
					"/alpha",
					Effect.gen(function* () {
						const shell = yield* Shell;
						yield* shell.exec(`hash -p /bin/echo ${marker}`);
						return yield* shell.exec(`hash -t ${marker}`);
					}),
				);
				const beta = yield* at(
					"/beta",
					Effect.flatMap(Shell, (shell) => shell.exec(`hash -t ${marker}`)),
				);
				return { alpha, beta };
			}).pipe(Effect.provide(transport)),
		);

		expect(result.alpha).toMatchObject({ exitCode: 0, stdout: "/bin/echo\n" });
		expect(result.beta.exitCode).not.toBe(0);
		expect(result.beta.stdout).toBe("");
	});
});

describe("SandboxIO identity", () => {
	// `cwd` is persisted, and `space` is keyed on a hash of the path:
	// a surviving trailing slash would be a second row for one directory. A
	// provider default (`getWorkDir()`) or a config value may carry one.
	it("canonicalizes a trailing slash out of the mount cwd", () => {
		expect(SandboxIO.resolveMountCwd("/workspace/")).toBe("/workspace");
		expect(SandboxIO.resolveMountCwd("/workspace/", "repo/")).toBe("/workspace/repo");
		expect(SandboxIO.resolveMountCwd("/workspace", "/tmp/")).toBe("/tmp");
		expect(SandboxIO.resolveMountCwd("/a//b/")).toBe("/a/b");
		// the namespace root is the one place a trailing slash *is* the path
		expect(SandboxIO.resolveMountCwd("/")).toBe("/");
		expect(SandboxIO.virtual({ driver: "memory", defaultCwd: "/" }).cwd).toBe("/");
	});
});
