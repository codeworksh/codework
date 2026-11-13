/* @effect-diagnostics nodeBuiltinImport:off -- the suite clones a repository and runs the CLI server. */
import { Clock, Effect, Layer, Stream } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import * as Client from "../src/server/client.ts";
import type { EventEnvelope } from "../src/server/envelope.ts";
import { models, serveCli, streaming, toolCalls, writeSettings } from "./fixtures/cli.ts";

const REPO = "https://github.com/codeworksh/69th";
const PINNED = "cdaec6762e3502f6aa3bbf851e855c9ba12b3a6b";
const STATUS = "plugin.git.status";

interface Status {
	readonly spaceId: string;
	readonly observedAt: number;
	readonly available: boolean;
	readonly head?: string;
	readonly branch?: string;
	readonly files: ReadonlyArray<{ readonly file: string; readonly status: string }>;
}

type SessionId = Parameters<Client.Client["thread.prompt"]>[0]["sessionId"];

const statusOf = (envelope: EventEnvelope) => envelope.data as Status;

/** The last status once it satisfies `until` and nothing newer came for a quiet period. */
const settle = (seen: ReadonlyArray<EventEnvelope>, until: (status: Status) => boolean) =>
	Effect.gen(function* () {
		const deadline = (yield* Clock.currentTimeMillis) + 120_000;
		for (;;) {
			const statuses = seen.filter((envelope) => envelope.type === STATUS);
			const latest = statuses.at(-1);
			if (latest !== undefined && until(statusOf(latest))) {
				yield* Effect.sleep("750 millis");
				if (seen.filter((envelope) => envelope.type === STATUS).length === statuses.length) return statusOf(latest);
				continue;
			}
			if ((yield* Clock.currentTimeMillis) > deadline)
				return yield* Effect.die(`no settled status after ${statuses.length} statuses`);
			yield* Effect.sleep("100 millis");
		}
	});

const stable = (status: Status) => {
	const { observedAt: _observedAt, spaceId: _spaceId, head, ...rest } = status;
	return { head: head === PINNED ? "<pinned>" : head === undefined ? undefined : "<commit>", ...rest };
};

/*
 * The git daemon through the real server: `event.subscribe` filtered to its type (nothing else
 * takes the client's queue), the last status replayed to a client that subscribes later, patches
 * pulled with `daemon.call`, and the replay gone after a restart until the next run.
 */
it("serves the git daemon over RPC: filtered push, replay, daemon.call and restart", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "codework-daemon-")));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const repo = join(root, "69th");
	mkdirSync(home);
	execFileSync("git", ["clone", "-q", REPO, repo], { stdio: "pipe" });
	execFileSync("git", ["-C", repo, "checkout", "-q", "-B", "main", PINNED], { stdio: "pipe" });

	let command = "true";
	// One bash call per prompt: a request whose last message is a tool result answers, any other asks.
	const fake = await streaming((body, response) => {
		if (body.messages.at(-1)?.role === "tool") {
			response.send({ role: "assistant", content: "done" });
			response.finish("stop");
			return;
		}
		response.send(toolCalls([{ name: "bash", arguments: { command } }]));
		response.finish("tool_calls");
	});
	writeSettings(home, fake.url);
	const start = () =>
		serveCli(["--home", home, "--user-config-dir", home], {
			cwd: repo,
			env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models },
		});

	const artifact: Record<string, unknown> = {};
	const connect = (url: string) =>
		Effect.gen(function* () {
			const context = yield* Layer.build(Client.layer(url));
			return yield* Client.make.pipe(Effect.provideContext(context));
		});
	const prompt = (rpc: Client.Client, sessionId: SessionId, next: string) =>
		Effect.gen(function* () {
			command = next;
			yield* rpc["thread.prompt"]({ sessionId, text: next });
			yield* rpc["thread.wait"]({ sessionId });
		});
	/** A fresh subscription: the frames it delivers right away, before anything new happens. */
	const replay = (rpc: Client.Client) =>
		rpc["event.subscribe"]({ types: [STATUS] }).pipe(
			Stream.interruptWhen(Effect.sleep("1500 millis")),
			Stream.runCollect,
			Effect.map((frames) =>
				[...frames].map((frame) => (frame.type === STATUS ? stable(statusOf(frame)) : frame.type)),
			),
		);

	const first = await start();
	let sessionId = "" as SessionId;
	let spaceId = "";
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const rpc = yield* connect(first.url);
				const seen: Array<EventEnvelope> = [];
				yield* rpc["event.subscribe"]({ types: [STATUS] }).pipe(
					Stream.runForEach((frame) => Effect.sync(() => seen.push(frame))),
					Effect.forkScoped,
				);
				yield* Effect.sleep("300 millis");

				const created = yield* rpc["session.create"]({ directory: repo, hostDir: repo as never });
				sessionId = created.session.id;
				yield* prompt(rpc, sessionId, "printf 'from the rpc e2e\\n' >> README.md && printf 'new\\n' > added.txt");
				const edited = yield* settle(seen, (status) => status.files.some((file) => file.file === "added.txt"));
				spaceId = edited.spaceId;
				artifact["pushed after an edit"] = stable(edited);
				artifact["types seen by the filtered subscriber"] = [...new Set(seen.map((frame) => frame.type))];

				const diff = (yield* rpc["daemon.call"]({
					plugin: "git",
					spaceId,
					method: "diff",
					input: { files: ["README.md"] },
				})) as {
					files: ReadonlyArray<{ file: string; patch: string; additions: number }>;
				};
				artifact["daemon.call diff"] = diff.files.map((file) => ({
					...file,
					patch: file.patch.replace(/^index .*$/m, "index <blobs>"),
				}));

				artifact["replayed to a late subscriber"] = yield* replay(rpc);

				const reason = (input: Parameters<Client.Client["daemon.call"]>[0]) =>
					rpc["daemon.call"](input).pipe(
						Effect.as("ok"),
						Effect.catchTag("DaemonCallError", (error) => Effect.succeed(error.reason)),
					);
				const reasons = {
					"unknown space": yield* reason({ plugin: "git", spaceId: "spc_missing", method: "diff", input: {} }),
					"unknown method": yield* reason({ plugin: "git", spaceId, method: "nope", input: {} }),
					"invalid input": yield* reason({ plugin: "git", spaceId, method: "diff", input: { context: "x" } }),
				};
				artifact["daemon.call errors"] = reasons;
			}),
		),
	);
	await first.stop();

	const second = await start();
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const rpc = yield* connect(second.url);
				artifact["replayed after a restart, before any run"] = yield* replay(rpc);
				const seen: Array<EventEnvelope> = [];
				yield* rpc["event.subscribe"]({ types: [STATUS] }).pipe(
					Stream.runForEach((frame) => Effect.sync(() => seen.push(frame))),
					Effect.forkScoped,
				);
				yield* Effect.sleep("300 millis");
				yield* prompt(rpc, sessionId, "git checkout -q -- README.md && rm added.txt");
				artifact["pushed after the next run"] = stable(yield* settle(seen, (status) => status.files.length === 0));
				artifact["replayed after that run"] = yield* replay(rpc);
			}),
		),
	);
	await second.stop();

	await expect(JSON.stringify(artifact, null, "\t")).toMatchFileSnapshot("./__artifacts__/daemon.git.rpc.json");
}, 300_000);
