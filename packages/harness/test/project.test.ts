import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Git } from "../src/git/git.ts";
import { Project } from "../src/project/project.ts";
import { Repo } from "../src/repo/repo.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { AbsolutePath } from "../src/schema.ts";
import { Space } from "../src/space/space.ts";
import { Hash } from "../src/util/hash.ts";
import { Worktree } from "../src/worktree/worktree.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { testEffect } from "./utils/effect.ts";

// Real git, real filesystem, real migrated in-memory database — the S-matrix
// from PROJECT.md §6 is end-to-end over temp repositories. A fresh layer (and
// so a fresh database) is built per test.
const layer = Project.layer.pipe(
	Layer.provideMerge(Space.layer),
	Layer.provide(Layer.mergeAll(Repo.layer, Worktree.layer)),
	Layer.provide(Git.layer),
	Layer.provideMerge(Layer.mergeAll(Database.layer(":memory:"), Sandbox.defaultLayer("/"))),
);

// `live`: real clock, so created_at ordering is meaningful.
const { live: it } = testEffect(layer);

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
	Effect.promise(async () => (await exec("git", args, { cwd })).stdout.trim());

const local = SandboxInstance.ID.local;
const spaceId = (location: string) => Space.id(local, location);
const abs = (location: string) => AbsolutePath.make(location);

// Scoped temp root; realpath'd because macOS puts tmp under a /var symlink.
const root = Effect.acquireRelease(
	Effect.promise(async () => {
		const dir = await tmpdir();
		return { ...dir, path: await fs.realpath(dir.path) };
	}),
	(dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.map((dir) => dir.path));

const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }));

const initRepo = Effect.fnUntraced(function* (dir: string, options: { origin?: string; commit?: boolean } = {}) {
	yield* mkdir(dir);
	yield* git(dir, "init", "-q", "-b", "main");
	yield* git(dir, "config", "user.email", "test@codework.sh");
	yield* git(dir, "config", "user.name", "Codework Test");
	if (options.origin) yield* git(dir, "remote", "add", "origin", options.origin);
	if (options.commit ?? true) yield* commit(dir, "a.txt");
	return dir;
});

const commit = Effect.fnUntraced(function* (dir: string, file: string) {
	yield* Effect.promise(() => fs.writeFile(path.join(dir, file), `${file}\n`));
	yield* git(dir, "add", file);
	yield* git(dir, "commit", "-q", "-m", `add ${file}`);
});

const rootCommit = (dir: string) => git(dir, "rev-list", "--max-parents=0", "HEAD");

const readMarker = (dir: string) =>
	Effect.promise(() => fs.readFile(path.join(dir, ".git", Repo.MARKER), "utf8").catch(() => undefined));

const resolve = (dir: string) => Effect.flatMap(Project.Service, (project) => project.resolveOrCreate(abs(dir)));

const seedSession = (id: string, space: string, directory: string) =>
	Effect.flatMap(
		SqlClient.SqlClient,
		(sql) => sql`
			INSERT INTO session (id, space_id, slug, directory, title, created_at, updated_at)
			VALUES (${id}, ${space}, ${id}, ${directory}, ${id}, 0, 0)
		`,
	);

const projects = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql<{ id: string; name: string; status: string }>`SELECT * FROM project ORDER BY id`,
);
const spaces = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql<{ id: string; projectId: string; location: string; kind: string; status: string }>`
		SELECT * FROM space ORDER BY location
	`,
);
const sessions = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql<{ id: string; spaceId: string; directory: string }>`SELECT * FROM session ORDER BY id`,
);

// §5.7 I1, I2 and I6, asserted after every scenario.
const invariants = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const primaries = yield* sql`
		SELECT project_id FROM space GROUP BY project_id, COALESCE(env, 'local') HAVING sum(kind = 'primary') > 1
	`;
	expect(primaries, "I1: at most one primary per (project, env)").toEqual([]);
	const orphans = yield* sql`
		SELECT s.id FROM session s LEFT JOIN space p ON p.id = s.space_id WHERE p.id IS NULL
	`;
	expect(orphans, "I2: every session points at a space").toEqual([]);
	const escaped = yield* sql`
		SELECT s.id FROM session s JOIN space p ON p.id = s.space_id
		WHERE NOT (s.directory = p.location OR s.directory LIKE p.location || '/%')
	`;
	expect(escaped, "I6: every session directory is at or under its space location").toEqual([]);
});

const remoteId = (normalized: string) => Hash.fast(`git:${normalized}`);

describe("Project.resolveOrCreate", () => {
	it("S1: a clone with an origin is identified by its remote and becomes the primary", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"), { origin: "git@github.com:Org/Repo.git" });

			const result = yield* resolve(dir);

			expect(result.project).toMatchObject({
				id: remoteId("github.com/org/repo"),
				name: "repo",
				status: "active",
				vcs: { type: "git", store: path.join(dir, ".git") },
			});
			expect(result.space).toMatchObject({ id: spaceId(dir), location: dir, kind: "primary", env: local });
			expect(result.directory).toBe(dir);
			expect(result.isDefault).toBe(true);
			expect(yield* readMarker(dir)).toBe(result.project.id);
			expect(yield* spaces).toHaveLength(1);
			yield* invariants;
		}));

	it("S2: opening a linked worktree first registers the whole family", () =>
		Effect.gen(function* () {
			const base = yield* root;
			const dir = yield* initRepo(path.join(base, "repo"));
			const feat = path.join(base, "repo-feat");
			yield* git(dir, "worktree", "add", "-q", "--detach", feat);

			const result = yield* resolve(feat);

			expect(result.space).toMatchObject({ location: feat, kind: "linked" });
			expect(result.isDefault).toBe(false);
			expect(yield* spaces).toMatchObject([
				{ location: dir, kind: "primary", projectId: result.project.id },
				{ location: feat, kind: "linked", projectId: result.project.id },
			]);
			yield* invariants;
		}));

	it("S3: plain directories are provisional projects; a subdirectory is a different one", () =>
		Effect.gen(function* () {
			const x = path.join(yield* root, "x");
			const y = path.join(x, "y");
			yield* mkdir(y);

			const first = yield* resolve(x);
			const second = yield* resolve(y);

			expect(first.project).toMatchObject({ id: Project.provisional(local, x), name: "x" });
			expect(first.project.vcs).toBeUndefined();
			expect(first.space).toMatchObject({ location: x, kind: "plain" });
			expect(first.isDefault).toBe(true);
			expect(second.project.id).toBe(Project.provisional(local, y));
			expect(second.project.id).not.toBe(first.project.id);
			expect(second.space).toMatchObject({ location: y, kind: "plain" });
			yield* invariants;
		}));

	it("S4: git init with an unborn HEAD keeps the provisional id and re-points the row to primary", () =>
		Effect.gen(function* () {
			const x = path.join(yield* root, "x");
			yield* mkdir(x);
			const plain = yield* resolve(x);

			yield* initRepo(x, { commit: false });
			const result = yield* resolve(x);

			expect(result.project.id).toBe(plain.project.id);
			expect(result.space).toMatchObject({ id: plain.space.id, kind: "primary" });
			expect(result.isDefault).toBe(true);
			expect(yield* readMarker(x)).toBeUndefined();
			expect(yield* spaces).toHaveLength(1);
			yield* invariants;
		}));

	it("S5: the first commit pins the root commit, re-points the worktree and absorbs the subdirectory", () =>
		Effect.gen(function* () {
			const x = path.join(yield* root, "x");
			const y = path.join(x, "y");
			yield* mkdir(y);
			const plainX = yield* resolve(x);
			const plainY = yield* resolve(y);
			yield* seedSession("sx", plainX.space.id, x);
			yield* seedSession("sy", plainY.space.id, y);
			yield* initRepo(x, { commit: false });
			yield* resolve(x); // S4 state

			yield* commit(x, "a.txt");
			const result = yield* resolve(x);

			const pinned = yield* rootCommit(x);
			expect(result.project.id).toBe(pinned);
			expect(yield* readMarker(x)).toBe(pinned);
			// same space id, new project, primary
			expect(result.space).toMatchObject({ id: plainX.space.id, projectId: pinned, kind: "primary" });
			// the subdirectory space is gone and its sessions re-pointed; directories are absolute and untouched
			expect(yield* spaces).toMatchObject([{ id: plainX.space.id, location: x }]);
			expect(yield* sessions).toMatchObject([
				{ id: "sx", spaceId: plainX.space.id, directory: x },
				{ id: "sy", spaceId: plainX.space.id, directory: y },
			]);
			// both provisional projects were deleted
			expect((yield* projects).map((row) => row.id)).toEqual([pinned]);
			yield* invariants;
		}));

	it("S6: adding an origin later does not move the id — the marker wins", () =>
		Effect.gen(function* () {
			const x = yield* initRepo(path.join(yield* root, "x"));
			const before = yield* resolve(x);

			yield* git(x, "remote", "add", "origin", "https://github.com/org/x.git");
			const after = yield* resolve(x);

			expect(after.project.id).toBe(before.project.id);
			expect(after.project.id).toBe(yield* rootCommit(x));
			expect(yield* projects).toHaveLength(1);
			yield* invariants;
		}));

	it("S11: a symlink alias of a checkout resolves to one space at the real location", () =>
		Effect.gen(function* () {
			const base = yield* root;
			const dir = yield* initRepo(path.join(base, "repo"));
			const alias = path.join(base, "alias");
			const linked = yield* Effect.promise(() =>
				fs
					.symlink(dir, alias)
					.then(() => true)
					.catch(() => false),
			);
			if (!linked) return; // no symlink support on this platform

			const viaAlias = yield* resolve(alias);
			const viaReal = yield* resolve(dir);

			expect(viaAlias.space.location).toBe(dir);
			expect(viaAlias.space.id).toBe(viaReal.space.id);
			expect(viaAlias.directory).toBe(dir);
			expect(yield* spaces).toHaveLength(1);
			yield* invariants;
		}));

	it("S12: a nested repository stays its own project and is not adopted by the outer one", () =>
		Effect.gen(function* () {
			const outer = yield* initRepo(path.join(yield* root, "repo"));
			// a different file, otherwise both repos get the same root commit (same tree, author, second)
			const lib = yield* initRepo(path.join(outer, "vendor", "lib"), { commit: false });
			yield* commit(lib, "lib.txt");

			const inner = yield* resolve(lib);
			const result = yield* resolve(outer);

			expect(inner.project.id).not.toBe(result.project.id);
			expect(yield* spaces).toMatchObject([
				{ location: outer, projectId: result.project.id, kind: "primary" },
				{ location: lib, projectId: inner.project.id, kind: "primary" },
			]);
			expect(yield* projects).toHaveLength(2);
			yield* invariants;
		}));

	it("S13: two clones of one remote share a project; the second is a copy", () =>
		Effect.gen(function* () {
			const base = yield* root;
			const origin = "https://github.com/org/repo";
			const a = yield* initRepo(path.join(base, "a"), { origin });
			const b = yield* initRepo(path.join(base, "b"), { origin });

			const first = yield* resolve(a);
			const second = yield* resolve(b);

			expect(second.project.id).toBe(first.project.id);
			expect(first.space.kind).toBe("primary");
			expect(second.space.kind).toBe("copy");
			expect(second.isDefault).toBe(false);
			yield* invariants;
		}));

	it("S16: with several root commits the sorted first one is the id", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"));
			yield* git(dir, "checkout", "-q", "--orphan", "other");
			yield* commit(dir, "b.txt");
			yield* git(dir, "checkout", "-q", "main");
			yield* git(dir, "merge", "-q", "--allow-unrelated-histories", "-m", "merge", "other");

			const roots = (yield* rootCommit(dir)).split("\n").sort();
			expect(roots).toHaveLength(2);

			const result = yield* resolve(dir);
			expect(result.project.id).toBe(roots[0]);
			yield* invariants;
		}));

	it("S21: concurrent resolves of the same cwd serialize to one identical registration", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"), { origin: "https://github.com/org/repo" });

			const [a, b] = yield* Effect.all([resolve(dir), resolve(dir)], { concurrency: 2 });

			expect(a).toEqual(b);
			expect(yield* spaces).toHaveLength(1);
			expect(yield* projects).toHaveLength(1);
			yield* invariants;
		}));

	it("S23: a renamed remote does not rename the stored project", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"), { origin: "https://github.com/org/old-name" });
			const before = yield* resolve(dir);
			expect(before.project.name).toBe("old-name");

			yield* git(dir, "remote", "set-url", "origin", "https://github.com/org/new-name");
			const after = yield* resolve(dir);

			expect(after.project.id).toBe(before.project.id);
			expect(after.project.name).toBe("old-name");
			yield* invariants;
		}));

	it("S25: a monorepo subdirectory resolves to the worktree space with its absolute directory", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"));
			const pkg = path.join(dir, "packages", "x");
			yield* mkdir(pkg);
			const top = yield* resolve(dir);

			const result = yield* resolve(pkg);

			expect(result.space.id).toBe(top.space.id);
			expect(result.directory).toBe(pkg);
			expect(result.isDefault).toBe(true);
			expect(yield* spaces).toHaveLength(1);
			yield* invariants;
		}));

	it("S26: the same subdirectory resolve works before the worktree was ever seen", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"));
			const pkg = path.join(dir, "packages", "x");
			yield* mkdir(pkg);

			const result = yield* resolve(pkg);

			expect(result.space).toMatchObject({ id: spaceId(dir), location: dir, kind: "primary" });
			expect(result.directory).toBe(pkg);
			expect(yield* spaces).toHaveLength(1);
			yield* invariants;
		}));

	it("S27: sessions below an absorbed plain subdirectory move to the parent space with their directory unchanged", () =>
		Effect.gen(function* () {
			const x = path.join(yield* root, "x");
			const y = path.join(x, "y");
			const z = path.join(y, "z");
			yield* mkdir(z);
			const plainY = yield* resolve(y);
			yield* seedSession("s", plainY.space.id, z);

			yield* initRepo(x);
			yield* resolve(x);

			expect(yield* sessions).toMatchObject([{ id: "s", spaceId: spaceId(x), directory: z }]);
			expect((yield* spaces).map((row) => row.location)).toEqual([x]);
			yield* invariants;
		}));

	it("S28: a returning archived primary becomes a copy; the promoted copy stays primary", () =>
		Effect.gen(function* () {
			const base = yield* root;
			const origin = "https://github.com/org/repo";
			const a = yield* initRepo(path.join(base, "a"), { origin });
			const b = yield* initRepo(path.join(base, "b"), { origin });
			const first = yield* resolve(a);
			yield* resolve(b);

			yield* Effect.promise(() => fs.rm(a, { recursive: true, force: true }));
			const service = yield* Space.Service;
			const refreshed = yield* service.refresh(first.project.id);
			expect(refreshed).toMatchObject([{ location: b, kind: "primary" }]);

			yield* initRepo(a, { origin });
			const back = yield* resolve(a);

			expect(back.space).toMatchObject({ id: spaceId(a), kind: "copy", status: "active" });
			expect(back.isDefault).toBe(false);
			expect(yield* spaces).toMatchObject([
				{ location: a, kind: "copy" },
				{ location: b, kind: "primary" },
			]);
			yield* invariants;
		}));

	it("get and list read back registered projects", () =>
		Effect.gen(function* () {
			const dir = yield* initRepo(path.join(yield* root, "repo"), { origin: "https://github.com/org/repo" });
			const resolved = yield* resolve(dir);
			const project = yield* Project.Service;

			const found = yield* project.get(resolved.project.id);
			expect(Option.getOrThrow(found)).toMatchObject({ id: resolved.project.id, name: "repo", status: "active" });
			expect(Option.isNone(yield* project.get(Project.provisional(local, "/nowhere")))).toBe(true);
			expect(yield* project.list()).toHaveLength(1);
		}));
});

describe("Repo.normalize", () => {
	// S15: every origin spelling of one repository collapses to the same key.
	for (const url of ["git@h:Org/Repo.git", "https://h/org/repo", "ssh://git@h/org/repo/"]) {
		it(`S15: ${url}`, () =>
			Effect.sync(() => {
				expect(Repo.normalize(url)).toBe("h/org/repo");
			}));
	}
});
