import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { ProjectSchema } from "../src/project/schema.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { AbsolutePath, RelativePath } from "../src/schema.ts";
import { SpaceSchema } from "../src/space/schema.ts";
import { Space } from "../src/space/space.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { testEffect } from "./utils/effect.ts";

// Real filesystem (probes are `fs.exists`), real migrated in-memory database.
const layer = Space.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Database.layer(":memory:"), Sandbox.defaultLayer("/"))),
);

const { live: it } = testEffect(layer);

const local = SandboxInstance.ID.local;
const remote = SandboxInstance.ID.make("sbx_a");
const project = (id: string) => ProjectSchema.ID.make(id);

const root = Effect.acquireRelease(
	Effect.promise(async () => {
		const dir = await tmpdir();
		return { ...dir, path: await fs.realpath(dir.path) };
	}),
	(dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.map((dir) => dir.path));

const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }));
const rm = (dir: string) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true }));

const seedProject = (id: string) =>
	Effect.flatMap(
		SqlClient.SqlClient,
		(sql) =>
			sql`INSERT INTO project (id, name, status, created_at, updated_at) VALUES (${id}, ${id}, 'active', 0, 0)`,
	);

// The host is NULL; anything else must exist in sandbox_instance first.
const seedEnv = (id: SandboxInstance.ID) =>
	Effect.flatMap(
		SqlClient.SqlClient,
		(sql) => sql`
			INSERT INTO sandbox_instance (id, driver, kind, ownership, status, state_observed_at, created_at, updated_at)
			VALUES (${id}, 'memory', 'virtual', 'managed', 'online', 0, 0, 0)
		`,
	);

interface Seed {
	readonly projectId: string;
	readonly location: string;
	readonly kind: SpaceSchema.Kind;
	readonly env?: SandboxInstance.ID;
	readonly status?: SpaceSchema.Status;
	readonly createdAt?: number;
}

const seedSpace = Effect.fnUntraced(function* (seed: Seed) {
	const sql = yield* SqlClient.SqlClient;
	const env = seed.env ?? local;
	const id = Space.id(env, seed.location);
	yield* sql`
		INSERT INTO space (id, project_id, location, kind, env, status, created_at, updated_at)
		VALUES (${id}, ${seed.projectId}, ${seed.location}, ${seed.kind}, ${SandboxInstance.toColumn(env)},
			${seed.status ?? "active"}, ${seed.createdAt ?? 0}, 0)
	`;
	return id;
});

const seedSession = (id: string, space: string, directory: string) =>
	Effect.flatMap(
		SqlClient.SqlClient,
		(sql) => sql`
			INSERT INTO session (id, space_id, slug, directory, title, created_at, updated_at)
			VALUES (${id}, ${space}, ${id}, ${directory}, ${id}, 0, 0)
		`,
	);

const spaces = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql<{ id: string; projectId: string; location: string; kind: string; status: string; env: string | null }>`
		SELECT * FROM space ORDER BY location
	`,
);

const projectStatus = (id: string) =>
	Effect.flatMap(SqlClient.SqlClient, (sql) =>
		Effect.map(sql<{ status: string }>`SELECT status FROM project WHERE id = ${id}`, (rows) => rows[0]?.status),
	);

describe("Space", () => {
	describe("refresh", () => {
		it("S10: archives a space whose directory was removed and leaves it out of the list", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const a = path.join(base, "a");
				const b = path.join(base, "b");
				yield* mkdir(a);
				yield* mkdir(b);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: a, kind: "primary" });
				yield* seedSpace({ projectId: "p", location: b, kind: "copy" });
				yield* rm(b);

				const service = yield* Space.Service;
				const result = yield* service.refresh(project("p"));

				expect(result).toMatchObject([{ location: a, kind: "primary", status: "active" }]);
				expect(yield* spaces).toMatchObject([
					{ location: a, status: "active" },
					{ location: b, status: "archived", kind: "copy" },
				]);
				expect(yield* projectStatus("p")).toBe("active");
			}));

		it("S9: promotes the oldest active copy when the primary is gone; linked is never promoted", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const primary = path.join(base, "repo");
				const linked = path.join(base, "repo-feat");
				const older = path.join(base, "copy-older");
				const newer = path.join(base, "copy-newer");
				for (const dir of [primary, linked, older, newer]) yield* mkdir(dir);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: primary, kind: "primary", createdAt: 1 });
				yield* seedSpace({ projectId: "p", location: linked, kind: "linked", createdAt: 2 });
				yield* seedSpace({ projectId: "p", location: newer, kind: "copy", createdAt: 20 });
				yield* seedSpace({ projectId: "p", location: older, kind: "copy", createdAt: 10 });
				yield* rm(primary);

				const service = yield* Space.Service;
				const result = yield* service.refresh(project("p"));

				expect(result).toMatchObject([
					{ location: newer, kind: "copy" },
					{ location: older, kind: "primary" },
					{ location: linked, kind: "linked" },
				]);
				// the dead primary was demoted so the unique index allowed the promotion
				expect(yield* spaces).toContainEqual(
					expect.objectContaining({ location: primary, kind: "copy", status: "archived" }),
				);
			}));

		it("leaves a project without copies primary-less rather than promoting a linked worktree", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const primary = path.join(base, "repo");
				const linked = path.join(base, "repo-feat");
				yield* mkdir(primary);
				yield* mkdir(linked);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: primary, kind: "primary" });
				yield* seedSpace({ projectId: "p", location: linked, kind: "linked" });
				yield* rm(primary);

				const service = yield* Space.Service;
				const result = yield* service.refresh(project("p"));

				expect(result).toMatchObject([{ location: linked, kind: "linked" }]);
				expect(yield* projectStatus("p")).toBe("active");
			}));

		it("archives the project once it has no active space in any env", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const gone = path.join(base, "gone");
				yield* mkdir(gone);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: gone, kind: "primary" });
				yield* rm(gone);

				const service = yield* Space.Service;
				expect(yield* service.refresh(project("p"))).toEqual([]);
				expect(yield* projectStatus("p")).toBe("archived");
			}));

		it("keeps the project active while another env still has an active space", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const gone = path.join(base, "gone");
				yield* mkdir(gone);
				yield* seedEnv(remote);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: gone, kind: "primary" });
				yield* seedSpace({ projectId: "p", location: "/workspace", kind: "primary", env: remote });
				yield* rm(gone);

				const service = yield* Space.Service;
				expect(yield* service.refresh(project("p"))).toEqual([]);
				expect(yield* projectStatus("p")).toBe("active");
				// the other env is never probed from here
				expect(yield* spaces).toContainEqual(
					expect.objectContaining({ location: "/workspace", env: "sbx_a", status: "active" }),
				);
			}));

		it("re-activates an archived space whose directory is back", () =>
			Effect.gen(function* () {
				const base = yield* root;
				const back = path.join(base, "back");
				yield* mkdir(back);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: back, kind: "copy", status: "archived" });

				const service = yield* Space.Service;
				const result = yield* service.refresh(project("p"));

				// re-activated, and promoted since the project had no primary
				expect(result).toMatchObject([{ location: back, kind: "primary", status: "active" }]);
			}));
	});

	describe("list / get", () => {
		it("lists only active spaces of this env, sorted by location", () =>
			Effect.gen(function* () {
				yield* seedEnv(remote);
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: "/z", kind: "primary" });
				yield* seedSpace({ projectId: "p", location: "/a", kind: "copy" });
				yield* seedSpace({ projectId: "p", location: "/m", kind: "copy", status: "archived" });
				yield* seedSpace({ projectId: "p", location: "/b", kind: "primary", env: remote });

				const service = yield* Space.Service;
				const result = yield* service.list(project("p"));

				expect(result.map((space) => space.location)).toEqual(["/a", "/z"]);
				expect(result[0]).toBeInstanceOf(SpaceSchema.Info);
				expect(result[0]?.env).toBe(local);

				const found = yield* service.get(Space.id(remote, "/b"));
				expect(Option.getOrThrow(found)).toMatchObject({ location: "/b", env: remote, kind: "primary" });
				expect(Option.isNone(yield* service.get(SpaceSchema.ID.make("missing")))).toBe(true);
			}));
	});

	describe("archiveEnv", () => {
		it("S30: archives every space of the env and projects left without an active space", () =>
			Effect.gen(function* () {
				yield* seedEnv(remote);
				yield* seedProject("only-remote");
				yield* seedProject("both");
				yield* seedProject("host-only");
				yield* seedSpace({ projectId: "only-remote", location: "/w1", kind: "primary", env: remote });
				yield* seedSpace({ projectId: "both", location: "/w2", kind: "primary", env: remote });
				yield* seedSpace({ projectId: "both", location: "/h2", kind: "primary" });
				yield* seedSpace({ projectId: "host-only", location: "/h3", kind: "primary" });

				const service = yield* Space.Service;
				yield* service.archiveEnv(remote);

				expect(yield* spaces).toMatchObject([
					{ location: "/h2", status: "active" },
					{ location: "/h3", status: "active" },
					{ location: "/w1", status: "archived" },
					{ location: "/w2", status: "archived" },
				]);
				expect(yield* projectStatus("only-remote")).toBe("archived");
				expect(yield* projectStatus("both")).toBe("active");
				expect(yield* projectStatus("host-only")).toBe("active");
			}));
	});

	describe("rehome", () => {
		it("inserts, then re-points project, kind and status on conflict without changing the id", () =>
			Effect.gen(function* () {
				yield* seedProject("p");
				yield* seedProject("q");
				const id = yield* seedSpace({ projectId: "p", location: "/x", kind: "plain", status: "archived" });

				const service = yield* Space.Service;
				yield* service.rehome({
					id,
					projectId: project("q"),
					location: AbsolutePath.make("/x"),
					kind: "primary",
					env: local,
				});

				expect(yield* spaces).toMatchObject([
					{ id, projectId: "q", location: "/x", kind: "primary", status: "active" },
				]);
			}));

		it("falls back to copy when another primary already holds the (project, env) slot", () =>
			Effect.gen(function* () {
				yield* seedProject("p");
				yield* seedSpace({ projectId: "p", location: "/a", kind: "primary" });

				const service = yield* Space.Service;
				yield* service.rehome({
					id: Space.id(local, "/b"),
					projectId: project("p"),
					location: AbsolutePath.make("/b"),
					kind: "primary",
					env: local,
				});

				expect(yield* spaces).toMatchObject([
					{ location: "/a", kind: "primary" },
					{ location: "/b", kind: "copy" },
				]);
			}));
	});

	describe("absorb", () => {
		it("moves sessions onto the parent with a re-based directory and deletes the stray", () =>
			Effect.gen(function* () {
				yield* seedProject("p");
				yield* seedProject("stray");
				const into = yield* seedSpace({ projectId: "p", location: "/x", kind: "primary" });
				const strayId = yield* seedSpace({ projectId: "stray", location: "/x/y", kind: "plain" });
				yield* seedSession("root", strayId, "");
				yield* seedSession("deep", strayId, "z");
				yield* seedSession("own", into, "k");

				const service = yield* Space.Service;
				yield* service.absorb({ strayId, into, rel: RelativePath.make("y") });

				const sql = yield* SqlClient.SqlClient;
				const sessions = yield* sql<{ id: string; spaceId: string; directory: string }>`
					SELECT id, space_id, directory FROM session ORDER BY id
				`;
				expect(sessions).toEqual([
					{ id: "deep", spaceId: into, directory: "y/z" },
					{ id: "own", spaceId: into, directory: "k" },
					{ id: "root", spaceId: into, directory: "y" },
				]);
				expect((yield* spaces).map((space) => space.id)).toEqual([into]);
			}));
	});
});
