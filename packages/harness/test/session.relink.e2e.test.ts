import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Sandbox } from "../src/effect/sandbox.ts";
import { Session } from "../src/effect/session.ts";
import { Git } from "../src/git/git.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import * as DaytonaDriver from "../src/sandboxes/daytona/index.ts";
import * as VercelDriver from "../src/sandboxes/vercel/index.ts";
import { Session as SessionStore } from "../src/session/session.ts";
import { Hash } from "../src/util/hash.ts";
import { remoteSuite } from "./fixtures/live.ts";
import { hasLiveOidc } from "./fixtures/vercel.ts";
import "./utils/env.ts";

const vercelToken = process.env.VERCEL_OIDC_TOKEN;
const daytonaKey = process.env.DAYTONA_API_KEY;
const suite = remoteSuite(
	"VERCEL_OIDC_TOKEN and DAYTONA_API_KEY",
	hasLiveOidc(vercelToken) && Boolean(daytonaKey?.trim()),
);

const remote = "https://github.com/codeworksh/69th";
const projectId = Hash.fast("git:github.com/codeworksh/69th");
// Two cloud provisions plus two clones, serially.
const TIMEOUT = 600_000;

suite("Session.relink across remote envs (vercel → daytona)", () => {
	it(
		"moves the session to a clone of the same project in another sandbox",
		async () => {
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "codework-relink-e2e-"));
			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						const sandboxes = yield* SandboxController.Controller;
						const store = yield* SessionStore.Service;

						const clone = (sandboxId: Parameters<typeof sandboxes.withMount>[0]) =>
							sandboxes.withMount(
								sandboxId,
								Effect.gen(function* () {
									const { cwd } = yield* SandboxIO.Current;
									const target = path.posix.join(cwd, "69th");
									const result = yield* Git.Service.use((git) =>
										git.clone({ remote, target, branch: "main", depth: 1 }),
									).pipe(Effect.provide(Git.layer));
									if (result.exitCode !== 0) {
										return yield* Effect.die(`clone failed: ${result.stderr || result.text}`);
									}
									return target;
								}),
							);

						const vercel = yield* Sandbox.create({
							driver: "vercel",
							config: { runtime: "node24", timeout: 15 * 60 * 1000 },
						});
						const daytona = yield* Sandbox.create({
							driver: "daytona",
							config: { language: "typescript" },
						});
						// Destroy requires the instance stopped first.
						const teardown = (id: Sandbox.SandboxInstance.ID) =>
							Sandbox.stop(id).pipe(Effect.andThen(Sandbox.destroy(id)), Effect.ignore);
						yield* Effect.addFinalizer(() => Effect.all([teardown(vercel.id), teardown(daytona.id)]));

						const repoVercel = yield* clone(vercel.id);
						const repoDaytona = yield* clone(daytona.id);

						// The session starts on the Vercel clone; one transcript entry is
						// enough to prove the log survives the move.
						const session = yield* Session.create({ sandbox: vercel, directory: repoVercel });
						yield* store.append({
							id: "e-before",
							sessionId: session.id,
							seq: 1,
							type: "user",
							data: JSON.stringify({ messageId: "e-before", role: "user", time: { created: 1 } }),
							parts: [{ type: "text", data: JSON.stringify({ type: "text", text: "before the move" }) }],
						});
						const before = Option.getOrThrow(yield* store.space(session.id));
						expect(before.env).toBe(vercel.id);
						expect(before.projectId).toBe(projectId);

						const moved = yield* Session.relink({
							sessionId: session.id,
							sandbox: daytona,
							directory: repoDaytona,
						});

						// The session sat at the repo root, so it lands on the new root —
						// realpath'd, which is space.location.
						const info = yield* moved.info;
						const after = Option.getOrThrow(yield* store.space(session.id));
						expect(after.env).toBe(daytona.id);
						expect(after.projectId).toBe(projectId);
						expect(info.directory).toBe(after.location);
						expect((yield* moved.path()).map(({ entry }) => entry.id)).toEqual(["e-before"]);

						// The source env going away afterwards archives its space but does
						// not touch the moved session.
						yield* Sandbox.stop(vercel.id);
						yield* Sandbox.destroy(vercel.id);
						const sql = yield* SqlClient.SqlClient;
						const rows = yield* sql<{ status: string }>`
							SELECT status FROM space WHERE id = ${before.id}
						`;
						expect(rows[0]?.status).toBe("archived");
						expect((yield* moved.info).directory).toBe(after.location);
					}).pipe(
						Effect.scoped,
						Effect.provide(
							Harness.layer({
								database: ":memory:",
								home,
								sandboxes: [VercelDriver.make(), DaytonaDriver.make()],
							}),
						),
					),
				);
			} finally {
				await fs.rm(home, { recursive: true, force: true });
			}
		},
		TIMEOUT,
	);
});
