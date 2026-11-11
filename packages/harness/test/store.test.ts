import "./utils/env.ts";
import { realpathSync } from "node:fs";
import { createAssistantMessageEventStream } from "@codeworksh/aikit";
import { Cause, DateTime, Effect, Exit, Layer, PubSub, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import * as Context from "../src/context/context.ts";
import * as Control from "../src/control.ts";
import * as Database from "../src/db/db.ts";
import * as Store from "../src/db/store.ts";
import * as Document from "../src/document/document.ts";
import * as Event from "../src/event/event.ts";
import * as EventList from "../src/event/list.ts";
import * as EventRegistry from "../src/event/registry.ts";
import * as Global from "../src/global.ts";
import { builtins } from "../src/plugin/builtin.ts";
import type { Plugin } from "../src/plugin/plugin.ts";
import * as RunnerExecute from "../src/runner/execute.ts";
import * as Hooks from "../src/runner/hooks.ts";
import * as LLM from "../src/runner/llm.ts";
import * as Loop from "../src/runner/loop.ts";
import * as Project from "../src/project/project.ts";
import * as SandboxController from "../src/sandbox/control.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import * as SandboxDriverRegistry from "../src/sandbox/registry.ts";
import * as Process from "../src/sandbox/utils/process.ts";
import * as Mcp from "../src/mcp/mcp.ts";
import * as PromptSchema from "../src/session/prompt/schema.ts";
import * as SessionProjector from "../src/session/projector.ts";
import * as SessionRuntime from "../src/session/runtime.ts";
import * as SessionSchema from "../src/session/schema.ts";
import * as Session from "../src/session/session.ts";
import * as Settings from "../src/settings/settings.ts";
import * as State from "../src/state/state.ts";
import * as ThreadSchema from "../src/thread/schema.ts";
import * as Thread from "../src/thread/thread.ts";
import * as Tool from "../src/tool/tool.ts";
import { assistant } from "./fixtures/llm.ts";
import { pooled } from "./fixtures/pool.ts";
import { seedSpace } from "./fixtures/space.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { testEffect } from "./utils/effect.ts";
import { named, credentials } from "./fixtures/model.ts";

// The first request calls `echo`, every one after replies: one turn settles a tool call.
let requests = 0;
const open: LLM.Open = (input) =>
	Effect.sync(() => {
		requests += 1;
		const call = requests === 1;
		const message = assistant(
			input,
			requests,
			call
				? {
						stopReason: "toolUse",
						parts: [
							{
								type: "toolCall",
								callID: "call_echo",
								name: "echo",
								arguments: { text: "hi" },
								status: "pending",
								time: { start: 1, end: 1 },
							},
						],
					}
				: {},
		);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
		return stream;
	});

const echo: Plugin = {
	id: "test.tool.echo",
	kind: "tool",
	setup: (ctx) => {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "echo",
					description: "echoes its text",
					parameters: Schema.Struct({ text: Schema.String }),
					success: Schema.String,
					handler: ({ text }) => Effect.succeed(text),
				}),
			),
		);
	},
};

const layer = () => {
	const database = Database.layer(":memory:");
	const sandbox = SandboxController.layer({ hostCwd: "/" }).pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	const seeded = pooled([...builtins, echo]);
	return Control.layer.pipe(
		Layer.provideMerge(
			RunnerExecute.layer.pipe(
				Layer.provide(Loop.layer({ request: LLM.make(open) }).pipe(Layer.provide(Hooks.layer))),
			),
		),
		Layer.provideMerge(State.layer({}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild)),
		Layer.provideMerge(credentials),
		Layer.provideMerge(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(
			Layer.succeed(Settings.Service, {
				load: () => Effect.succeed(named),
				locate: () => Effect.die("unused"),
			}),
		),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.storeLayer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
	);
};

const { effect: it } = testEffect(layer());

const wired = ["project", "space", "session", "thread", "entry", "inbox"] as const;

// Test-only: every write to a wired row, and every tombstone, lands in `journal` with the rev it
// carries, in write order. Nothing in the store reads it.
const installJournal = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE journal (n INTEGER PRIMARY KEY AUTOINCREMENT, rev INTEGER, tbl TEXT, op TEXT, id TEXT)`;
	for (const table of [...wired, "removed"]) {
		for (const op of table === "removed" ? ["insert"] : ["insert", "update"]) {
			yield* sql.unsafe(`
				CREATE TRIGGER journal_${table}_${op} AFTER ${op.toUpperCase()} ON ${table}
				BEGIN INSERT INTO journal (rev, tbl, op, id) VALUES (NEW.rev, '${table}', '${op}', NEW.id); END
			`);
		}
	}
	// Names the commit: an event row is the last write of its transaction, after its projectors. Every
	// durable event of this script projects onto a wired row, so the head is its own revision.
	yield* sql.unsafe(`
		CREATE TRIGGER journal_event AFTER INSERT ON event
		BEGIN INSERT INTO journal (rev, tbl, op, id) VALUES ((SELECT rev FROM store), 'event', NEW.type, NEW.id); END
	`);
});

/** Ids in the order first seen, so the artifact reads `T1`, `E3` rather than uuids. */
const aliases = () => {
	const names = new Map<string, string>();
	const counters = new Map<string, number>();
	return (prefix: string, id: string) => {
		const known = names.get(id);
		if (known !== undefined) return known;
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		const name = `${prefix}${next}`;
		names.set(id, name);
		return name;
	};
};
const prefixes: Record<string, string> = {
	project: "P",
	space: "SP",
	session: "S",
	thread: "T",
	entry: "E",
	inbox: "I",
};

/** The trigger's message, off a rejected write. */
const rejection = (exit: Exit.Exit<unknown, unknown>) => {
	if (Exit.isSuccess(exit)) return "accepted";
	let error: unknown = Cause.squash(exit.cause);
	while (error instanceof Error && !error.message.includes("rev") && error.cause !== undefined) error = error.cause;
	return error instanceof Error ? error.message : String(error);
};

describe("store", () => {
	it(
		"every write takes one revision in commit order; documents stamp threads; a delete leaves a tombstone",
		Effect.gen(function* () {
			requests = 0;
			const sql = yield* SqlClient.SqlClient;
			const store = yield* Store.Service;
			const sessions = yield* Session.Service;
			const threads = yield* Thread.Service;
			const documents = yield* Document.Service;
			const events = yield* Event.Service;
			const control = yield* Control.Service;
			yield* installJournal;
			const doorbell = yield* store.wake;
			const name = aliases();
			const steps: Array<{ step: string; head: number }> = [];
			const step = (label: string) =>
				store.head.pipe(Effect.map(({ rev }) => void steps.push({ step: label, head: rev })));

			const before = yield* store.head;
			yield* step("start");

			// A plain directory, seeded under the id resolution gives it: the run's resolve then
			// rewrites the same two rows instead of adopting strays.
			const dir = yield* Effect.acquireRelease(
				Effect.promise(() => tmpdir()),
				(dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
			);
			const directory = realpathSync(dir.path);
			const { spaceId, location } = yield* seedSpace({
				location: directory,
				projectId: Project.provisional(SandboxInstance.ID.local, directory),
			});
			yield* step("seed project and space");

			const created = yield* sessions.create({ spaceId, directory: location });
			const sessionId = SessionSchema.ID.make(created.session.id);
			const main = ThreadSchema.ID.make(created.thread.id);
			yield* step("session.create");
			const rang = Exit.isSuccess(yield* PubSub.take(doorbell).pipe(Effect.timeout("1 second"), Effect.exit));

			yield* events.publish(EventList.ThreadConfigured, {
				timestamp: yield* DateTime.now,
				sessionId,
				threadId: main,
				change: { model: { provider: "openai", id: "gpt-5.4" } },
			});
			yield* step("thread.configure (thread-scoped agent document)");

			yield* control.run({
				sessionId,
				threadId: main,
				prompt: PromptSchema.Prompt.fromText("Say hi"),
				delivery: "followUp",
			});
			yield* step("prompt (tool call, settle, reply)");

			const line = yield* threads.line(main);
			const last = line.findLast(({ entry }) => entry.type === "assistant")!;
			const forked = yield* threads.fork({ threadId: main, entryId: last.entry.id });
			yield* step("fork");

			yield* documents.create({
				sessionId,
				definition: { kind: "test.shared", version: 1, scope: "session" },
				value: { shared: true },
				seq: (yield* events.latestSequence(sessionId)) + 1,
			});
			yield* step("session-scoped document");

			const settled = yield* store.head;
			const bad = {
				// A plain write outside `Store.write`: it carries a stale rev.
				staleRev: rejection(
					yield* sql`UPDATE thread SET title = 'bad', rev = ${settled.rev - 1} WHERE id = ${main}`.pipe(
						Effect.exit,
					),
				),
				// Inside a write, an update that forgets to stamp keeps the old rev.
				forgotStamp: rejection(
					yield* store
						.write(
							Effect.gen(function* () {
								yield* store.rev;
								yield* sql`UPDATE thread SET title = 'bad' WHERE id = ${main}`;
							}),
						)
						.pipe(Effect.exit),
				),
				// An insert without a revision taken.
				insertWithoutRevision: rejection(
					yield* sql`
						INSERT INTO project (id, name, status, created_at, updated_at, rev)
						VALUES ('bad', 'bad', 'active', 0, 0, ${settled.rev + 1})
					`.pipe(Effect.exit),
				),
				// A rejected write rolls back with its revision.
				headUnchanged: (yield* store.head).rev === settled.rev,
			};

			const rows = Effect.gen(function* () {
				const out: Record<string, Array<string>> = {};
				for (const table of wired) {
					const found = yield* sql.unsafe<{ id: string; rev: number }>(
						`SELECT id, rev FROM ${table} ORDER BY rev, rowid`,
					);
					out[table] = found.map((row) => `${name(prefixes[table]!, row.id)} rev=${row.rev}`);
				}
				return out;
			});
			const beforeDelete = yield* rows;

			const deleted = yield* sessions.delete(sessionId);
			yield* step("session.delete");
			const afterDelete = yield* rows;
			const removed = yield* sql<{ kind: string; id: string; rev: number }>`SELECT kind, id, rev FROM removed`;

			const journal = yield* sql<{ rev: number; tbl: string; op: string; id: string }>`
				SELECT rev, tbl, op, id FROM journal ORDER BY n
			`;
			const head = yield* store.head;

			// Revisions commit in order: the journal never steps back, and every step's writes carry
			// revisions above the previous step's head.
			const revs = journal.map((row) => row.rev);
			expect(revs).toEqual(revs.toSorted((a, b) => a - b));
			expect(deleted).toBe(true);
			expect(rang).toBe(true);
			expect(forked.thread.id).toBeDefined();

			// One commit per revision: the event that made it, or a plain write, and the rows it stamped.
			const commits = new Map<number, { rev: number; by: string; writes: Array<string> }>();
			for (const row of journal) {
				const commit = commits.get(row.rev) ?? { rev: row.rev, by: "plain write", writes: [] };
				commits.set(row.rev, commit);
				if (row.tbl === "event") {
					expect(commit.writes.length).toBeGreaterThan(0);
					commit.by = row.op.replace(/\.\d+$/, "");
				} else if (row.tbl === "removed") commit.writes.push(`removed ${name("S", row.id)}`);
				else commit.writes.push(`${row.tbl} ${name(prefixes[row.tbl]!, row.id)} ${row.op}`);
			}

			yield* Effect.promise(() =>
				expect(
					`${JSON.stringify(
						{
							store: {
								idIsSet: before.id.length > 0,
								startRev: before.rev,
								sameId: head.id === before.id,
								head: head.rev,
							},
							doorbellRang: rang,
							steps,
							commits: [...commits.values()],
							rowsBeforeDelete: beforeDelete,
							rowsAfterDelete: afterDelete,
							removed: removed.map((row) => `${row.kind} ${name("S", row.id)} rev=${row.rev}`),
							rejected: bad,
						},
						null,
						"\t",
					)}\n`,
				).toMatchFileSnapshot("./__artifacts__/store.revision.json"),
			);
		}),
	);
});
