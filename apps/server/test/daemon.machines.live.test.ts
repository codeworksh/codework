/* @effect-diagnostics nodeBuiltinImport:off -- the suite runs CodeWork servers on OrbStack Linux machines. */
import { Effect, type Layer, ManagedRuntime, Option, type Scope, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, Sandbox } from "../../../packages/harness/src/effect.ts";
import * as SandboxController from "../../../packages/harness/src/sandbox/control.ts";
import * as DaytonaDriver from "../../../packages/harness/src/sandboxes/daytona/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type * as Client from "../../../packages/codework/src/server/client.ts";
import type { EventEnvelope } from "../../../packages/codework/src/server/envelope.ts";
import "../../../packages/harness/test/utils/env.ts";
import { available, ensure, machine } from "./machines/orb.ts";

/*
 * Space daemons with the CodeWork server itself on another computer: a CodeWork server (scripted
 * model, real `bash`) on an OrbStack Linux machine, driven from the Mac over its RPC endpoint.
 * - A host space on that machine: git status pushed, replayed, diffed, and gone after a restart.
 * - A Daytona sandbox driven from that machine (its credentials moved there): the same, plus a
 *   stopped sandbox the daemon must never wake.
 */

const REPO = "https://github.com/codeworksh/69th";
const PINNED = "cdaec6762e3502f6aa3bbf851e855c9ba12b3a6b";
const STATUS = "plugin.git.status";
const cw = machine("cw-a");

interface Status {
	readonly spaceId: string;
	readonly available: boolean;
	readonly head?: string;
	readonly branch?: string;
	readonly files: ReadonlyArray<{ readonly file: string; readonly status: string; readonly additions: number }>;
	readonly reason?: string;
}

type SessionId = Parameters<Client.Client["thread.prompt"]>[0]["sessionId"];

const statusOf = (frame: EventEnvelope) => frame.data as Status;
const stable = (status: Status) => {
	const { spaceId: _spaceId, head, ...rest } = status as Status & { observedAt?: number; message?: string };
	const {
		observedAt: _observedAt,
		message: _message,
		...kept
	} = rest as typeof rest & {
		observedAt?: number;
		message?: string;
	};
	return { head: head === PINNED ? "<pinned>" : head === undefined ? undefined : "<commit>", ...kept };
};

/** Statuses a subscription saw; `settle` waits for one matching `until` that nothing newer followed. */
const watch = (rpc: Client.Client) =>
	Effect.gen(function* () {
		const seen: Array<EventEnvelope> = [];
		yield* rpc["event.subscribe"]({ types: [STATUS] }).pipe(
			Stream.runForEach((frame) => Effect.sync(() => seen.push(frame))),
			Effect.forkScoped,
		);
		yield* Effect.sleep("500 millis");
		const settle = (until: (status: Status) => boolean, spaceId?: string) =>
			Effect.gen(function* () {
				const deadline = Date.now() + 300_000;
				for (;;) {
					const mine = seen.filter(
						(frame) => frame.type === STATUS && (spaceId === undefined || statusOf(frame).spaceId === spaceId),
					);
					const latest = mine.at(-1);
					if (latest !== undefined && until(statusOf(latest))) {
						yield* Effect.sleep("1500 millis");
						const after = seen.filter(
							(frame) => frame.type === STATUS && (spaceId === undefined || statusOf(frame).spaceId === spaceId),
						);
						if (after.length === mine.length) return statusOf(latest);
						continue;
					}
					if (Date.now() > deadline)
						return yield* Effect.die(`no settled status; last: ${JSON.stringify(latest?.data ?? null)}`);
					yield* Effect.sleep("200 millis");
				}
			});
		return { seen, settle };
	});

const prompt = (rpc: Client.Client, sessionId: SessionId, command: string) =>
	Effect.gen(function* () {
		yield* rpc["thread.prompt"]({ sessionId, text: `bash ${command}` });
		yield* rpc["thread.wait"]({ sessionId });
	});

/** A fresh subscription's first frames: the replay, before anything new happens. */
const replay = (rpc: Client.Client) =>
	rpc["event.subscribe"]({ types: [STATUS] }).pipe(
		Stream.interruptWhen(Effect.sleep("2 seconds")),
		Stream.runCollect,
		Effect.map((frames) =>
			[...frames].map((frame) => (frame.type === STATUS ? stable(statusOf(frame)) : frame.type)),
		),
	);

const diffOf = (rpc: Client.Client, spaceId: string, files?: ReadonlyArray<string>) =>
	rpc["daemon.call"]({ plugin: "git", spaceId, method: "diff", input: files === undefined ? {} : { files } }).pipe(
		Effect.map((output) => {
			const result = output as {
				files: ReadonlyArray<{ file: string; patch: string; additions: number; deletions: number; status: string }>;
				cached?: true;
			};
			return {
				...(result.cached === true ? { cached: true } : {}),
				files: result.files.map((file) => ({ ...file, patch: file.patch.replace(/^index .*$/m, "index <blobs>") })),
			};
		}),
		Effect.catchTag("DaemonCallError", (error) => Effect.succeed({ error: error.reason })),
	);

/** One shared harness on the Mac, owning the Daytona sandboxes the suite creates. */
let macRuntime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof Harness.layer>>, unknown> | undefined;
const mac = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof Harness.layer>>>) => {
	macRuntime ??= ManagedRuntime.make(
		Harness.layer({
			database: ":memory:",
			home: mkdtempSync(join(tmpdir(), "daemon-mac-")),
			plugins: [],
			sandboxes: [DaytonaDriver.make()],
		}),
	);
	return macRuntime.runPromise(effect);
};

/** `cw.run` for a program that keeps subscriptions open until it returns. */
const scoped = <A, E>(use: (rpc: Client.Client) => Effect.Effect<A, E, Scope.Scope>) =>
	cw.run((rpc) => Effect.scoped(use(rpc)));

const describeMachines = available ? describe : describe.skip;

describeMachines("space daemons with the server on another machine", () => {
	beforeAll(async () => {
		await ensure(cw.name);
		await cw.setup();
	}, 1_800_000);

	afterAll(async () => {
		await cw.stop("KILL").catch(() => undefined);
		await macRuntime?.dispose();
	}, 120_000);

	it("a host space on the server's machine: push, replay, diff, restart", async () => {
		await cw.stop("KILL").catch(() => undefined);
		await cw.wipe();
		const base = `/home/${process.env.USER}/daemon-e2e`;
		await cw.sh(
			`rm -rf ${base} && mkdir -p ${base} && cd ${base} && git clone -q ${REPO} 69th && git -C 69th checkout -q -B main ${PINNED}`,
		);
		const repo = `${base}/69th`;
		await cw.start();
		const artifact: Record<string, unknown> = {};
		const ids = await scoped((rpc) =>
			Effect.gen(function* () {
				const { settle } = yield* watch(rpc);
				const created = yield* rpc["session.create"]({ directory: repo, hostDir: repo as never });
				const sessionId = created.session.id;
				yield* prompt(
					rpc,
					sessionId,
					"printf 'from another machine\\n' >> README.md && printf 'x\\n' > remote.txt",
				);
				const edited = yield* settle((status) => status.files.some((file) => file.file === "remote.txt"));
				artifact["pushed after an edit"] = stable(edited);
				artifact["diff while the space is idle"] = yield* diffOf(rpc, edited.spaceId, ["README.md"]);
				artifact["replayed to a late subscriber"] = yield* replay(rpc);
				return { sessionId, spaceId: edited.spaceId };
			}),
		);
		await cw.stop("TERM");
		await cw.start();
		await scoped((rpc) =>
			Effect.gen(function* () {
				artifact["replayed after a restart"] = yield* replay(rpc);
				const { settle } = yield* watch(rpc);
				yield* prompt(rpc, ids.sessionId, "git checkout -q -- README.md && rm remote.txt");
				artifact["pushed after the next run"] = stable(yield* settle((status) => status.files.length === 0));
			}),
		);
		await expect(JSON.stringify(artifact, null, "\t")).toMatchFileSnapshot(
			"./__artifacts__/daemon.machines.host.json",
		);
	}, 900_000);

	const daytona = process.env.DAYTONA_API_KEY?.trim();
	(daytona ? it : it.skip)(
		"a daytona sandbox driven from the server's machine: push, cached diff, and no wake",
		async () => {
			await cw.stop("KILL").catch(() => undefined);
			await cw.wipe();
			await cw.start({ DAYTONA_API_KEY: daytona ?? "" });
			const artifact: Record<string, unknown> = {};
			// Created and destroyed from the Mac, which owns it; the machine's server attaches it as an existing sandbox.
			const created = await mac(Sandbox.create({ driver: "daytona", config: { language: "typescript" } }));
			const providerResourceId = Option.getOrThrow(created.providerResourceId);
			try {
				await scoped((rpc) =>
					Effect.gen(function* () {
						const { settle } = yield* watch(rpc);
						const sandbox = yield* rpc["sandbox.register"]({ driver: "daytona", providerResourceId });
						const home = "/home/daytona";
						const setup = yield* rpc["session.create"]({ sandbox: { id: sandbox.id }, directory: home });
						yield* prompt(
							rpc,
							setup.session.id,
							`git clone -q ${REPO} 69th && git -C 69th checkout -q -B main ${PINNED}`,
						);
						artifact["the sandbox's own folder is not a repository"] = stable(
							yield* settle((status) => !status.available),
						);
						const session = yield* rpc["session.create"]({
							sandbox: { id: sandbox.id },
							directory: `${home}/69th`,
						});
						yield* prompt(
							rpc,
							session.session.id,
							"printf 'from daytona\\n' >> README.md && printf 'y\\n' > sandbox.txt",
						);
						const edited = yield* settle((status) => status.files.some((file) => file.file === "sandbox.txt"));
						artifact["pushed after an edit in the sandbox"] = stable(edited);
						artifact["diff right after the run"] = yield* diffOf(rpc, edited.spaceId, ["README.md"]);

						// Let the handover and the warm transport close, then the owner stops it. The machine's server only
						// attached it, so it may not stop it, and its own row still says it is online.
						yield* Effect.sleep("40 seconds");
						yield* Effect.promise(() => mac(Sandbox.stop(created.id)));
						artifact["the machine's row after the owner stopped it"] = (yield* rpc["sandbox.list"]({})).find(
							(info) => info.id === sandbox.id,
						)?.status;
						artifact["diff once it is stopped"] = yield* diffOf(rpc, edited.spaceId, ["README.md"]);
						yield* Effect.sleep("5 seconds");
						// Asked of the provider from the Mac, not the machine's stored row: a woken sandbox would show here.
						artifact["provider status after that call"] = (yield* Effect.promise(() =>
							mac(Effect.flatMap(SandboxController.Controller, (controller) => controller.refresh(created.id))),
						)).status;
						artifact["replayed while it is stopped"] = yield* replay(rpc);
					}),
				);
			} finally {
				await mac(Sandbox.stop(created.id).pipe(Effect.ignore, Effect.andThen(Sandbox.destroy(created.id)))).catch(
					(error: unknown) => console.warn(`daytona sandbox ${providerResourceId} may have leaked`, error),
				);
			}
			await expect(JSON.stringify(artifact, null, "\t")).toMatchFileSnapshot(
				"./__artifacts__/daemon.machines.daytona.json",
			);
		},
		1_200_000,
	);
});
