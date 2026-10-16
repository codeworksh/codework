import { Effect, type Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { quote } from "../src/sandbox/shell/shell.ts";
import { conformanceSpec, interruptWitness } from "./fixtures/conformance.spec.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

// The local drivers. Vercel and Daytona run the same spec from their E2E files,
// over the one sandbox each already provisions. memory and sqldb are just-bash
// over a VFS, so they are also the just-bash conformance.

const layerRunner =
	(make: () => Layer.Layer<Sandbox.Provides>) =>
	<A, E>(program: Effect.Effect<A, E, Sandbox.Provides>) =>
		Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(make())));

conformanceSpec({
	driver: "memory",
	run: layerRunner(() => Sandbox.memory()),
	cwd: "/",
	combinesOutput: false,
	cancels: true,
	inheritsHostEnv: false,
	linux: false,
});

describe("sqldb, file-backed", () => {
	let directory = "";
	beforeAll(async () => {
		directory = (await tmpdir()).path;
	});
	afterAll(() => fs.rm(directory, { recursive: true, force: true }));

	conformanceSpec({
		driver: "sqldb",
		run: layerRunner(() => Sandbox.sqldb({ location: path.join(directory, "fs.db") })),
		cwd: "/",
		combinesOutput: false,
		cancels: true,
		inheritsHostEnv: false,
		linux: false,
	});
});

describe("host", () => {
	// macOS reaches the temp directory through a symlink, which `pwd` reports resolved.
	let directory = "";
	beforeAll(async () => {
		directory = await fs.realpath((await tmpdir()).path);
	});
	afterAll(() => fs.rm(directory, { recursive: true, force: true }));
	const run = <A, E>(program: Effect.Effect<A, E, Sandbox.Provides>) =>
		Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Sandbox.local(directory))));

	conformanceSpec({
		driver: "host",
		run,
		get cwd() {
			return directory;
		},
		combinesOutput: false,
		cancels: true,
		inheritsHostEnv: true,
		linux: process.platform === "linux",
	});

	// A child that ignores SIGTERM must not outlive the interrupt: the host
	// SIGKILLs the process group once the grace runs out.
	it("kills a child that ignores SIGTERM when the command is interrupted", async () => {
		const witness = path.join(directory, "sigterm-progress");
		const result = await run(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				return yield* interruptWitness(
					`(trap '' TERM; while :; do echo tick >> ${quote(witness)}; sleep 0.2; done) & wait`,
					witness,
					2000,
				).pipe(Effect.ensuring(filesystem.rm(witness, { force: true }).pipe(Effect.ignore)));
			}),
		);
		expect(result.settled).toBeGreaterThan(0);
		expect(result.later).toBe(result.settled);
	}, 60_000);
});
