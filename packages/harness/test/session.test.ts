import { Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

// Fresh in-memory database per test: the layer is rebuilt for every it.effect.
const layer = Session.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const it = testEffect(layer);

// In production an entry's seq is the sequence of the event that produced it.
// These tests exercise the tree directly, with no event log behind them, so a
// per-session counter stands in. Dense here; sparse in production.
const seqCounters = new Map<string, number>();
const nextSeq = (sessionId: string) => {
	const next = (seqCounters.get(sessionId) ?? 0) + 1;
	seqCounters.set(sessionId, next);
	return next;
};
// A fork copies entry positions verbatim and seeds the new aggregate above
// them, so the stand-in counter has to continue from the source's position.
const inheritSeq = (sourceId: string, forkId: string) => {
	seqCounters.set(forkId, seqCounters.get(sourceId) ?? 0);
};
beforeEach(() => seqCounters.clear());

const createSession = (slug: string) =>
	Effect.gen(function* () {
		// session.space_id references space(id)
		const { spaceId, location } = yield* seedSpace();
		const session = yield* Session.Service;
		return yield* session.create({
			spaceId,
			slug,
			directory: location,
			title: "Test session",
			tag: "test",
		});
	});

const userEntry = (sessionId: SessionSchema.ID, id: string, text: string): Session.AppendEntry => ({
	id,
	sessionId,
	seq: nextSeq(sessionId),
	type: "user",
	data: JSON.stringify({ messageId: id, role: "user", time: { created: 1 } }),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text }) }],
});

const usage = (
	input: Partial<Pick<SessionSchema.Usage, "input" | "output" | "cacheRead" | "cacheWrite">> & {
		readonly costTotal?: number;
	} = {},
): SessionSchema.Usage => {
	const tokens = {
		input: input.input ?? 0,
		output: input.output ?? 0,
		cacheRead: input.cacheRead ?? 0,
		cacheWrite: input.cacheWrite ?? 0,
	};
	return {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: input.costTotal ?? 0,
		},
	};
};

const assistantEntry = (
	sessionId: SessionSchema.ID,
	id: string,
	options?: { usage?: SessionSchema.Usage; toolCall?: { callId: string; toolName: string } },
): Session.AppendEntry => ({
	id,
	sessionId,
	seq: nextSeq(sessionId),
	type: "assistant",
	state: options?.toolCall === undefined ? "committed" : "draft",
	data: JSON.stringify({
		messageId: id,
		role: "assistant",
		stopReason: "stop",
		usage: options?.usage ?? usage(),
	}),
	parts: [
		{ type: "text", data: JSON.stringify({ type: "text", text: "ok" }) },
		...(options?.toolCall
			? [
					{
						type: "toolCall" as const,
						status: "pending" as const,
						callId: options.toolCall.callId,
						toolName: options.toolCall.toolName,
						data: JSON.stringify({
							type: "toolCall",
							callID: options.toolCall.callId,
							name: options.toolCall.toolName,
							status: "pending",
						}),
					},
				]
			: []),
	],
});

describe("session", () => {
	it.effect("assistant appends bump the session usage aggregates", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-usage");

			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(
				assistantEntry(created.id, "e2", {
					usage: usage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costTotal: 0.5 }),
				}),
			);
			yield* session.append(userEntry(created.id, "e3", "again"));
			yield* session.append(
				assistantEntry(created.id, "e4", {
					usage: usage({ input: 150, output: 30, cacheRead: 90, cacheWrite: 0, costTotal: 0.25 }),
				}),
			);

			const row = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(row.tokensInput).toBe(250);
			expect(row.tokensOutput).toBe(50);
			expect(row.tokensCacheRead).toBe(130);
			expect(row.tokensCacheWrite).toBe(10);
			expect(row.cost).toBeCloseTo(0.75);
		}),
	);

	it.effect("path walks root→leaf across a branch point", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-branch");

			yield* session.append(userEntry(created.id, "e1", "start"));
			yield* session.append(assistantEntry(created.id, "e2"));
			yield* session.append(userEntry(created.id, "e3", "approach A"));
			yield* session.append(assistantEntry(created.id, "e4"));

			// abandon A: move the leaf back to e2 and take approach B
			yield* session.branch({ sessionId: created.id, entryId: "e2" });
			yield* session.append(userEntry(created.id, "e5", "approach B"));

			const path = yield* session.path(created.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1", "e2", "e5"]);

			// abandoned branch stays queryable on the full timeline
			const timeline = yield* session.timeline({ sessionId: created.id });
			expect(timeline.map((h) => h.entry.id)).toEqual(["e5", "e4", "e3", "e2", "e1"]);

			// e5 is a sibling of e3 (both children of e2)
			const e5 = timeline.find((h) => h.entry.id === "e5")!;
			expect(Option.getOrElse(e5.entry.parentId, () => "")).toBe("e2");
		}),
	);

	it.effect("append validates an explicit parentId against the session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-parent-a");
			const b = yield* createSession("s-parent-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));
			yield* session.append(userEntry(b.id, "eb1", "in session b"));

			// cross-session parent is rejected typed
			const result = yield* session
				.append({ ...userEntry(b.id, "eb2", "bad parent"), parentId: "ea1" })
				.pipe(Effect.flip);
			expect(result._tag).toBe("EntryNotFoundError");

			// same-session explicit parent works (sibling branch append)
			const sibling = yield* session.append({ ...userEntry(b.id, "eb3", "good parent"), parentId: "eb1" });
			expect(Option.getOrElse(sibling.parentId, () => "")).toBe("eb1");
		}),
	);

	it.effect("duplicate call ids within an entry are rejected by the schema", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-dup-call");

			const toolPart = (callId: string): Session.AppendPart => ({
				type: "toolCall",
				status: "pending",
				callId,
				toolName: "read",
				data: JSON.stringify({ type: "toolCall", callID: callId, name: "read", status: "pending" }),
			});

			const exit = yield* session
				.append({
					...assistantEntry(created.id, "e1"),
					parts: [toolPart("call_dup"), toolPart("call_dup")],
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// the failed transaction rolled back whole — no partial entry
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
		}),
	);

	it.effect("append validates compaction shape and boundary against its actual parent path", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-compaction-guard");
			const other = yield* createSession("s-compaction-guard-other");
			yield* session.append(userEntry(source.id, "e1", "root"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.branch({ sessionId: source.id, entryId: "e1" });
			yield* session.append(userEntry(source.id, "e3", "active sibling"));
			yield* session.append(userEntry(other.id, "other-e1", "foreign"));

			const invalidCompactions: ReadonlyArray<Session.AppendEntry> = [
				{
					id: "c-missing-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "missing", tokensBefore: 10 }),
				},
				{
					id: "c-negative-tokens",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "negative", firstKeptEntryId: null, tokensBefore: -1 }),
				},
				{
					id: "c-abandoned-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "abandoned", firstKeptEntryId: "e2", tokensBefore: 10 }),
				},
				{
					id: "c-foreign-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "foreign", firstKeptEntryId: "other-e1", tokensBefore: 10 }),
				},
			];

			for (const input of invalidCompactions) {
				const error = yield* session.append(input).pipe(Effect.flip);
				expect(error._tag).toBe("InvalidEntryDataError");
				expect(Option.isNone(yield* session.entry(input.id))).toBe(true);
			}
			const afterInvalid = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(afterInvalid.leafEntryId, () => "")).toBe("e3");
			expect(yield* session.timeline({ sessionId: source.id })).toHaveLength(3);

			// The explicit parent, not the current leaf, defines the compaction path.
			const anchored = yield* session.append({
				id: "c-anchored",
				sessionId: source.id,
				seq: nextSeq(source.id),
				parentId: "e2",
				type: "compaction",
				data: JSON.stringify({ summary: "root work", firstKeptEntryId: "e1", tokensBefore: 10 }),
			});
			expect(Option.getOrElse(anchored.parentId, () => "")).toBe("e2");

			const wrongAnchor = yield* session
				.append({
					id: "c-wrong-anchor",
					sessionId: source.id,
					seq: nextSeq(source.id),
					parentId: "e2",
					type: "compaction",
					data: JSON.stringify({ summary: "wrong path", firstKeptEntryId: "e3", tokensBefore: 10 }),
				})
				.pipe(Effect.flip);
			expect(wrongAnchor._tag).toBe("InvalidEntryDataError");
			expect(Option.isNone(yield* session.entry("c-wrong-anchor"))).toBe(true);
			const afterWrongAnchor = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(afterWrongAnchor.leafEntryId, () => "")).toBe("c-anchored");

			const summaryOnly = yield* session.append({
				id: "c-summary-only",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "all prior work", firstKeptEntryId: null, tokensBefore: 10 }),
			});
			expect(JSON.parse(summaryOnly.data).firstKeptEntryId).toBeNull();
		}),
	);

	it.effect("clone (fork at leaf) copies the path with fresh identity", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-clone-src");
			yield* session.append(userEntry(source.id, "e1", "hello"));
			yield* session.append(assistantEntry(source.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));
			yield* session.setLabel({ sessionId: source.id, entryId: "e1", label: "start" });

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-clone" });

			// lineage + fresh session state
			expect(Option.getOrElse(fork.parentId, () => "")).toBe(source.id);
			expect(fork.cost).toBe(0);
			expect(fork.title).toBe(source.title);

			const forkPath = yield* session.path(fork.id);
			const sourcePath = yield* session.path(source.id);
			expect(forkPath.map((h) => h.entry.type)).toEqual(sourcePath.map((h) => h.entry.type));
			// all new entry ids, dense seq, envelope messageId rewritten to the new id
			for (const [i, hydrated] of forkPath.entries()) {
				expect(hydrated.entry.id).not.toBe(sourcePath[i]!.entry.id);
				expect(hydrated.entry.seq).toBe(i + 1);
				expect(JSON.parse(hydrated.entry.data).messageId).toBe(hydrated.entry.id);
			}
			// parts copied verbatim with preserved partIndex; label rode along
			const forkAssistant = forkPath[1]!;
			expect(forkAssistant.parts.map((p) => p.partIndex)).toEqual([0, 1]);
			expect(Option.getOrElse(forkAssistant.parts[1]!.callId, () => "")).toBe("call_1");
			expect(Option.getOrElse(forkPath[0]!.entry.label, () => "")).toBe("start");
			// pending toolCall copied as pending → fork inherits recovery
			expect(yield* session.unsettled(fork.id)).toHaveLength(1);

			// source untouched
			const sourceAfter = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(sourceAfter.leafEntryId, () => "")).toBe("e2");
			expect((yield* session.timeline({ sessionId: source.id })).length).toBe(2);
		}),
	);

	it.effect("fork copies only the active path, not abandoned branches", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-branches-src");
			yield* session.append(userEntry(source.id, "e1", "start"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append(userEntry(source.id, "e3", "approach A"));
			yield* session.branch({ sessionId: source.id, entryId: "e2" });
			yield* session.append(userEntry(source.id, "e5", "approach B"));

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-branches" });

			// source has 4 entries; fork has only the active path e1→e2→e5
			const forkTimeline = yield* session.timeline({ sessionId: fork.id });
			expect(forkTimeline).toHaveLength(3);
			const forkPath = yield* session.path(fork.id);
			expect(forkPath.map((h) => JSON.parse(h.entry.data).messageId ?? h.entry.id)).toEqual(
				forkPath.map((h) => h.entry.id),
			);
			// fork diverges independently of the source
			inheritSeq(source.id, fork.id);
			yield* session.append(userEntry(fork.id, "f6", "fork continues"));
			expect((yield* session.timeline({ sessionId: source.id })).length).toBe(4);
			expect((yield* session.timeline({ sessionId: fork.id })).length).toBe(4);
		}),
	);

	it.effect("fork remaps compaction firstKeptEntryId into the new session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-compaction-src");
			yield* session.append(userEntry(source.id, "e1", "old"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append({
				id: "c3",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "earlier work", firstKeptEntryId: "e2", tokensBefore: 1000 }),
			});
			yield* session.append(userEntry(source.id, "e4", "after compaction"));
			yield* session.append({
				id: "c5",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "all prior work", firstKeptEntryId: null, tokensBefore: 500 }),
			});

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-compaction" });
			const forkPath = yield* session.path(fork.id);

			const forkE2 = forkPath[1]!.entry; // copy of e2
			const forkCompaction = forkPath[2]!.entry;
			const forkSummaryOnly = forkPath[4]!.entry;
			expect(forkCompaction.type).toBe("compaction");
			const payload = JSON.parse(forkCompaction.data);
			// window pointer follows the copy — not the old session's id
			expect(payload.firstKeptEntryId).toBe(forkE2.id);
			expect(payload.firstKeptEntryId).not.toBe("e2");
			expect(payload.summary).toBe("earlier work");
			expect(JSON.parse(forkSummaryOnly.data).firstKeptEntryId).toBeNull();
		}),
	);

	it.effect("forkBefore a user entry lands at its parent; validates entry type", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-before-src");
			yield* session.append(userEntry(source.id, "e1", "keep me"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append(userEntry(source.id, "e3", "redo this prompt"));

			// before e3 → fork contains e1, e2; leaf = copy of e2
			const fork = yield* session.fork({
				sessionId: source.id,
				entryId: "e3",
				mode: "before",
				slug: "s-fork-before",
			});
			const forkPath = yield* session.path(fork.id);
			expect(forkPath).toHaveLength(2);
			expect(forkPath.map((h) => h.entry.type)).toEqual(["user", "assistant"]);

			// before a non-user entry is a typed structural rejection
			const invalid = yield* session
				.fork({ sessionId: source.id, entryId: "e2", mode: "before", slug: "s-fork-before-bad" })
				.pipe(Effect.flip);
			expect(invalid._tag).toBe("InvalidEntryDataError");

			// before the root user entry → empty fork
			const empty = yield* session.fork({
				sessionId: source.id,
				entryId: "e1",
				mode: "before",
				slug: "s-fork-before-empty",
			});
			expect(Option.isNone(empty.leafEntryId)).toBe(true);
			expect(yield* session.path(empty.id)).toHaveLength(0);
		}),
	);

	describe("relink", () => {
		// Two spaces of one project: the env move relinks between them.
		const seedPair = Effect.fnUntraced(function* () {
			const from = yield* seedSpace({ location: "/old/app", projectId: "p", kind: "primary" });
			const to = yield* seedSpace({ location: "/new/app", projectId: "p", kind: "copy" });
			return { from, to };
		});

		it.effect("keeps the session's position under the new root", () =>
			Effect.gen(function* () {
				const { from, to } = yield* seedPair();
				const session = yield* Session.Service;
				const created = yield* session.create({
					spaceId: from.spaceId,
					slug: "s-relink",
					directory: AbsolutePath.make("/old/app/packages/x"),
					title: "t",
				});

				const moved = yield* session.relink({ sessionId: created.id, spaceId: to.spaceId });
				expect(moved.spaceId).toBe(to.spaceId);
				expect(moved.directory).toBe("/new/app/packages/x");

				// Sitting at the old root lands on the new root.
				const atRoot = yield* session.create({
					spaceId: from.spaceId,
					slug: "s-relink-root",
					directory: from.location,
					title: "t",
				});
				const movedRoot = yield* session.relink({ sessionId: atRoot.id, spaceId: to.spaceId });
				expect(movedRoot.directory).toBe("/new/app");
			}),
		);

		it.effect("an explicit directory under the target wins; outside it is rejected", () =>
			Effect.gen(function* () {
				const { from, to } = yield* seedPair();
				const session = yield* Session.Service;
				const created = yield* session.create({
					spaceId: from.spaceId,
					slug: "s-relink-dir",
					directory: AbsolutePath.make("/old/app/pkg"),
					title: "t",
				});

				const explicit = yield* session.relink({
					sessionId: created.id,
					spaceId: to.spaceId,
					directory: AbsolutePath.make("/new/app/other"),
				});
				expect(explicit.directory).toBe("/new/app/other");

				const rejected = yield* session
					.relink({ sessionId: created.id, spaceId: to.spaceId, directory: AbsolutePath.make("/nope") })
					.pipe(Effect.flip);
				expect(rejected).toMatchObject({ _tag: "RelinkError", reason: "directory_outside_space" });
			}),
		);

		it.effect("rejects a space of another project without touching the session", () =>
			Effect.gen(function* () {
				const { from } = yield* seedPair();
				const other = yield* seedSpace({ location: "/other", projectId: "q", kind: "primary" });
				const session = yield* Session.Service;
				const created = yield* session.create({
					spaceId: from.spaceId,
					slug: "s-relink-x",
					directory: from.location,
					title: "t",
				});

				const error = yield* session.relink({ sessionId: created.id, spaceId: other.spaceId }).pipe(Effect.flip);
				expect(error).toMatchObject({ _tag: "RelinkError", reason: "project_scope_mismatch" });
				const row = Option.getOrThrow(yield* session.get(created.id));
				expect(row.spaceId).toBe(from.spaceId);
			}),
		);
	});
});
