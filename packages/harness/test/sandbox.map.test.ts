import { Effect } from "effect";
import { posix as path } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SandboxEnv } from "../src/sandbox/env";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { SandboxRegistry } from "../src/sandbox/map";
import { Sandbox } from "../src/sandbox/sandbox";
import { Shell } from "../src/sandbox/shell";
import { tmpdir } from "./fixtures/tempdir";

describe("SandboxEnv address", () => {
	it("round-trips every kind", () => {
		const cases = ["local", "memory:01H8", "sqldb:/var/fs.db", "vercel:my-box", "daytona:abc123"];
		for (const envId of cases) {
			const address = SandboxEnv.parse(envId);
			expect(address, envId).toBeDefined();
			expect(SandboxEnv.format(address!)).toBe(envId);
		}
	});

	it("splits on the first colon so an instance may contain colons", () => {
		expect(SandboxEnv.parse("sqldb:/var/a:b.db")).toEqual({ kind: "sqldb", instance: "/var/a:b.db" });
	});

	it("rejects an unknown kind", () => {
		expect(SandboxEnv.parse("hetzner:box")).toBeUndefined();
		expect(SandboxEnv.parse("")).toBeUndefined();
	});

	it("rejects non-canonical address shapes", () => {
		expect(SandboxEnv.parse("local:alias")).toBeUndefined();
		expect(SandboxEnv.parse("memory")).toBeUndefined();
		expect(SandboxEnv.parse("sqldb")).toBeUndefined();
		expect(SandboxEnv.parse("vercel")).toBeUndefined();
		expect(SandboxEnv.parse("daytona:")).toBeUndefined();
	});

	// Distinctness is required of every namespace; reattachability is not.
	it("separates addresses that can be resolved from those that cannot", () => {
		const reattachable = (envId: string) => {
			const address = SandboxEnv.parse(envId);
			return address !== undefined && SandboxEnv.isReattachable(address);
		};

		expect(reattachable("local")).toBe(true);
		expect(reattachable("sqldb:/var/fs.db")).toBe(true);
		expect(reattachable("vercel:my-box")).toBe(true);

		expect(reattachable("memory:01H8")).toBe(false);
		expect(reattachable("sqldb:01H8")).toBe(false); // in-memory sqlite, not a file
		expect(reattachable("vercel")).toBe(false); // no box named
	});

	it("mints distinct ids for namespaces that have no identity of their own", () => {
		const a = SandboxEnv.mint("memory");
		const b = SandboxEnv.mint("memory");

		expect(a).not.toBe(b);
		expect(SandboxEnv.parse(a)?.kind).toBe("memory");
	});
});

describe("Sandbox constructors", () => {
	// A backend and its identity cannot be chosen independently: an in-memory VFS
	// calling itself `local` would claim the host's namespace.
	it("gives each ephemeral sandbox its own identity, never the host's", async () => {
		const read = (sandbox: Sandbox.Sandbox) =>
			Effect.runPromise(
				Effect.flatMap(SandboxEnv.EnvId, Effect.succeed).pipe(Effect.scoped, Effect.provide(sandbox)),
			);

		const [first, second] = await Promise.all([read(Sandbox.memory()), read(Sandbox.memory())]);

		expect(first).not.toBe(second);
		expect(first).not.toBe(SandboxEnv.DEFAULT);
		expect(SandboxEnv.parse(first)?.kind).toBe("memory");
	});

	it("names a file-backed sqldb by its path, and an in-memory one by a minted id", async () => {
		await using tmp = await tmpdir();
		const absoluteLocation = path.join(tmp.path, "absolute.db");
		const relativeLocation = path.relative(process.cwd(), path.join(tmp.path, "fs.db"));
		const read = (sandbox: Sandbox.Sandbox) =>
			Effect.runPromise(
				Effect.flatMap(SandboxEnv.EnvId, Effect.succeed).pipe(Effect.scoped, Effect.provide(sandbox)),
			);

		expect(await read(Sandbox.sqldb({ location: absoluteLocation }))).toBe(
			SandboxEnv.format({ kind: "sqldb", instance: absoluteLocation }),
		);
		expect(await read(Sandbox.sqldb({ location: relativeLocation }))).toBe(
			SandboxEnv.format({ kind: "sqldb", instance: path.resolve(relativeLocation) }),
		);
		expect(SandboxEnv.parse(await read(Sandbox.sqldb()))?.kind).toBe("sqldb");
		expect(await read(Sandbox.sqldb())).not.toBe(SandboxEnv.format({ kind: "sqldb", instance: absoluteLocation }));
	});
});

describe("SandboxMap", () => {
	const resolve = <A, E>(
		envId: string,
		body: Effect.Effect<A, E, Sandbox.Provides>,
		options?: SandboxRegistry.Options,
	) =>
		Effect.runPromise(
			body.pipe(
				Effect.scoped,
				Effect.provide(SandboxRegistry.SandboxMap.get(envId)),
				Effect.provide(SandboxRegistry.layer(options)),
				Effect.exit,
			),
		);

	it("resolves `local` to a working filesystem and shell", async () => {
		await using tmp = await tmpdir();

		const exit = await resolve(
			"local",
			Effect.gen(function* () {
				const fs = yield* SandboxFileSystem.Service;
				const shell = yield* Shell;
				yield* fs.writeFile("from-map.txt", "resolved");
				return yield* shell.exec("cat from-map.txt");
			}),
			{ cwd: tmp.path },
		);

		expect(exit._tag).toBe("Success");
		if (exit._tag === "Success") expect(exit.value.stdout).toBe("resolved");
	});

	// Resolving an ephemeral address would hand back an empty namespace wearing
	// the right name — indistinguishable from success, and quietly wrong.
	it("refuses to fabricate a namespace that cannot be reattached", async () => {
		const exit = await resolve("memory:01H8", Effect.succeed("unreachable"));

		expect(exit._tag).toBe("Failure");
	});

	it("refuses an unknown kind", async () => {
		const exit = await resolve("hetzner:box", Effect.succeed("unreachable"));

		expect(exit._tag).toBe("Failure");
	});

	it("refuses aliases whose requested id would differ from the sandbox identity", async () => {
		const exit = await resolve("local:alias", Effect.succeed("unreachable"));

		expect(exit._tag).toBe("Failure");
	});

	it("shares one environment between concurrent users of the same id", async () => {
		await using tmp = await tmpdir();

		// Both writes must land in the same namespace, and the second reader must
		// see the first writer's file.
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const write = Effect.gen(function* () {
					const fs = yield* SandboxFileSystem.Service;
					yield* fs.writeFile("shared.txt", "once");
				}).pipe(Effect.provide(SandboxRegistry.SandboxMap.get("local")));

				const read = Effect.gen(function* () {
					const fs = yield* SandboxFileSystem.Service;
					return yield* fs.readFile("shared.txt");
				}).pipe(Effect.provide(SandboxRegistry.SandboxMap.get("local")));

				yield* write;
				return yield* read;
			}).pipe(Effect.scoped, Effect.provide(SandboxRegistry.layer({ cwd: tmp.path })), Effect.exit),
		);

		expect(exit._tag).toBe("Success");
		if (exit._tag === "Success") expect(exit.value).toBe("once");
	});
});
