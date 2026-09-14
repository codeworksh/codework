import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Location } from "../src/location/location.ts";
import { ProjectSchema } from "../src/project/schema.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { AbsolutePath } from "../src/schema.ts";
import { Hash } from "../src/util/hash.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

// Keep the real Database/Global wiring (exercised through Location.defaultLayer)
// off the user's disk: any layer built from path() lands in an in-memory db.
process.env.CODEWORK_DB ??= ":memory:";

const exec = promisify(execFile);
const gitCli = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

const initRepo = async (repo: string, remote: string) => {
	await fs.mkdir(repo, { recursive: true });
	await gitCli(repo, "init", "-q");
	await gitCli(repo, "config", "user.email", "test@codework.sh");
	await gitCli(repo, "config", "user.name", "Codework Test");
	await gitCli(repo, "remote", "add", "origin", remote);
	await fs.writeFile(path.join(repo, "README.md"), "hello");
	await gitCli(repo, "add", ".");
	await gitCli(repo, "commit", "-q", "-m", "init");
};

// Location over the host sandbox. The database stays a requirement so a test
// can resolve two refs through the same rows.
const resolve = (directory: string) =>
	Location.Service.use(Effect.succeed).pipe(
		Effect.provide(
			Location.layerMounted({ directory: AbsolutePath.make(directory) }).pipe(
				Layer.provide(Sandbox.defaultLayer("/")),
			),
		),
	);

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(program.pipe(Effect.provide(Database.layer(":memory:"))));

describe("Location", () => {
	it("resolves a git checkout to its primary space at the root", async () => {
		await using tmp = await tmpdir();
		const repo = path.join(tmp.path, "widget");
		await initRepo(repo, "https://github.com/codeworksh/widget.git");
		const realRepo = await fs.realpath(repo);

		const location = await run(resolve(repo));

		expect(location.directory).toBe(realRepo);
		expect(location.space.kind).toBe("primary");
		expect(location.space.location).toBe(realRepo);
		expect(location.space.env).toBe(SandboxInstance.ID.local);
		expect(location.project.id).toBe(ProjectSchema.ID.make(Hash.fast("git:github.com/codeworksh/widget")));
		expect(location.project.name).toBe("widget");
		expect(location.project.vcs).toEqual({ type: "git", store: path.join(realRepo, ".git") });
	});

	it("resolves a plain directory to a plain space", async () => {
		await using tmp = await tmpdir();
		const plain = path.join(tmp.path, "scratch");
		await fs.mkdir(plain);
		const realPlain = await fs.realpath(plain);

		const location = await run(resolve(plain));

		expect(location.directory).toBe(realPlain);
		expect(location.space.kind).toBe("plain");
		expect(location.space.location).toBe(realPlain);
		expect(location.project.name).toBe("scratch");
		expect(location.project.vcs).toBeUndefined();
	});

	// S25: a monorepo subdirectory keeps the worktree as its space and its own
	// absolute cwd as the directory.
	it("keeps a subdirectory cwd under the worktree space", async () => {
		await using tmp = await tmpdir();
		const repo = path.join(tmp.path, "mono");
		await initRepo(repo, "https://github.com/codeworksh/mono.git");
		const subdir = path.join(repo, "packages", "x");
		await fs.mkdir(subdir, { recursive: true });
		const realRepo = await fs.realpath(repo);
		const realSubdir = await fs.realpath(subdir);

		const [root, nested] = await run(Effect.all([resolve(repo), resolve(subdir)]));

		expect(nested.directory).toBe(realSubdir);
		expect(nested.space).toEqual(root.space);
		expect(nested.space.location).toBe(realRepo);
		expect(nested.project.id).toBe(root.project.id);
	});

	// The convenience wiring itself: defaultLayer needs nothing but the ref and
	// a sandbox root.
	it("builds through Location.defaultLayer", async () => {
		await using tmp = await tmpdir();
		const plain = path.join(tmp.path, "scratch");
		await fs.mkdir(plain);

		const location = await Effect.runPromise(
			Location.Service.use(Effect.succeed).pipe(
				Effect.provide(Location.defaultLayer({ directory: AbsolutePath.make(plain) }, "/")),
			),
		);

		expect(location.space.kind).toBe("plain");
		expect(location.directory).toBe(await fs.realpath(plain));
	}, 30_000);
});
