/* @effect-diagnostics nodeBuiltinImport:off -- the suite runs a CodeWork server on an OrbStack Linux machine. */
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Control, Session } from "../../../packages/harness/src/effect.ts";
import { snapshot as match, waitFor } from "./fixtures/apps.ts";
import { available, ensure, machine, orb } from "./machines/orb.ts";

/*
 * Durable runs across real failures of a real computer: the fixture CodeWork server (scripted model)
 * runs on the OrbStack machine cw-a while the suite SIGKILLs it, shuts the whole machine down,
 * crash-loops it, and cuts and throttles its network. What the store holds is read inside the
 * machine with sqlite3; `recovery.machines.<name>.json` records the log and the rows across each
 * failure, with log positions named by the event at them.
 */

const cw = machine("cw-a");
const work = `${cw.cwHome}/work`;
type Ids = { readonly sessionId: string; readonly threadId: string };
type Row = Record<string, unknown>;

/**
 * Waits until the Mac reaches the server: after the machine boots, OrbStack takes up to a minute to
 * route `<name>.orb.local` to it again.
 */
const reachable = () =>
	waitFor(
		() =>
			fetch(cw.url.replace(/^ws/, "http"), { signal: AbortSignal.timeout(3_000) }).then(
				() => true,
				() => undefined,
			),
		"the server from the Mac",
		180_000,
	);

/** A fresh store, with retries fast and many so a crash loop is the host's, not the request's. */
const fresh = async () => {
	await cw.net("restore");
	await cw.net("fast");
	await cw.stop("KILL");
	await cw.wipe();
	await cw.sh(
		`mkdir -p ${work} && printf '%s' '{"retry":{"maxRetries":10,"baseDelayMs":10,"maxDelayMs":1000}}' > ${cw.cwHome}/settings.jsonc`,
	);
	await cw.start();
	await reachable();
};

const create = () =>
	cw.run((rpc) =>
		rpc["session.create"]({ directory: work }).pipe(
			Effect.map((created): Ids => ({ sessionId: created.session.id, threadId: created.id })),
		),
	);

const prompt = (ids: Ids, text: string, options: { delivery?: "steer" | "followUp"; id?: string } = {}) =>
	cw.run((rpc) =>
		rpc["thread.prompt"]({
			sessionId: Session.SessionSchema.ID.make(ids.sessionId),
			threadId: Session.ThreadSchema.ID.make(ids.threadId),
			text,
			...(options.delivery === undefined ? {} : { delivery: options.delivery }),
			...(options.id === undefined ? {} : { id: Session.SessionMessageSchema.ID.make(options.id) }),
		}),
	);

const ref = (ids: Ids) => ({
	sessionId: Session.SessionSchema.ID.make(ids.sessionId),
	threadId: Session.ThreadSchema.ID.make(ids.threadId),
});
const idle = (ids: Ids) => cw.run((rpc) => rpc["thread.wait"](ref(ids)));
const queue = (ids: Ids) =>
	cw.run((rpc) => rpc["thread.queue"](ref(ids)).pipe(Effect.map(({ entries }) => entries.map((one) => one.text))));

type Event = { readonly seq: number; readonly type: string; readonly data: Row };

/** The session's durable log, read in the machine; the type without its version. */
const events = async (ids: Ids): Promise<Array<Event>> =>
	(await cw.sql(`SELECT seq, type, data FROM event WHERE aggregate_id = '${ids.sessionId}' ORDER BY seq`)).map(
		(row) => ({
			seq: Number(row["seq"]),
			type: (row["type"] as string).replace(/\.\d+$/, ""),
			data: JSON.parse(row["data"] as string) as Row,
		}),
	);

const textOf = (data: Row) =>
	((data["prompt"] as { parts?: ReadonlyArray<{ text?: string }> } | undefined)?.parts ?? [])
		.map((part) => part.text ?? "")
		.join("");

const shown = new Set([
	"session.prompt.admitted",
	"session.prompt.promoted",
	"session.prompt.updated",
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.stopping",
	"session.execution.interrupted",
	"session.run.failed",
	"session.llm.started",
	"session.llm.failed",
]);

/** What an event says, without ids, times or messages that carry them. */
const describeEvent = (event: Event) => {
	const { type, data } = event;
	if (type === "session.prompt.admitted" || type === "session.prompt.promoted")
		return `${type} ${data["delivery"] as string} "${textOf(data)}"`;
	if (type === "session.prompt.updated") return `${type} ${(data["delivery"] as string | undefined) ?? ""}`.trim();
	if (type === "session.execution.started") return `${type} resumed=${String(data["resumed"] as boolean)}`;
	if (type === "session.execution.interrupted" || type === "session.run.failed")
		return `${type} ${data["reason"] as string}`;
	return type;
};

const count = (log: ReadonlyArray<Event>, type: string) => log.filter((event) => event.type === type).length;

/** The thread's row and its prompts, log positions named by the event at them. */
const rows = async (ids: Ids) => {
	const log = await events(ids);
	const at = (seq: unknown) => {
		if (seq === null || seq === undefined || seq === 0) return null;
		const event = log.find((one) => one.seq === Number(seq));
		return event === undefined ? `unmatched ${seq as number}` : describeEvent(event);
	};
	const [thread] = await cw.sql(
		`SELECT head, restarts, run_state, run_outcome, run_error FROM thread WHERE id = '${ids.threadId}'`,
	);
	const prompts = await cw.sql(
		`SELECT data, delivery, admitted_seq, tail, promoted_seq FROM inbox WHERE thread_id = '${ids.threadId}' ORDER BY admitted_seq`,
	);
	const head = Number(thread!["head"]);
	return {
		head: at(head),
		restarts: thread!["restarts"],
		runState: thread!["run_state"],
		outcome: thread!["run_outcome"],
		error: thread!["run_error"] === null ? null : (JSON.parse(thread!["run_error"] as string) as Row),
		prompts: prompts.map((row) => ({
			text: textOf({ prompt: JSON.parse(row["data"] as string) }),
			delivery: row["delivery"],
			tail: at(row["tail"]),
			promoted: at(row["promoted_seq"]),
			runnable: row["promoted_seq"] === null && Number(row["tail"]) > head,
		})),
	};
};

/** The lifecycle part of the log, in order. */
const lifecycle = async (ids: Ids) =>
	(await events(ids)).filter((event) => shown.has(event.type)).map((event) => describeEvent(event));

/** Waits until the log holds `n` events of `type`, and returns it. */
const logged = (ids: Ids, type: string, n = 1, timeout = 120_000) =>
	waitFor(
		async () => {
			const log = await events(ids);
			return count(log, type) >= n ? log : undefined;
		},
		`${n} × ${type}`,
		timeout,
	);

/** Waits until the thread's request is out, as the store records it. */
const inFlight = (ids: Ids, timeout = 120_000) =>
	waitFor(
		async () => {
			const [row] = await cw.sql(`SELECT run_state, attempt FROM thread WHERE id = '${ids.threadId}'`);
			return row?.["run_state"] === "running" && row["attempt"] !== null ? row : undefined;
		},
		"the request in flight",
		timeout,
	);

/** Gives a server that just started time to resume what it owes, then says what ran since `from`. */
const settledSince = async (ids: Ids, from: number) => {
	await new Promise((resolve) => setTimeout(resolve, 3_000));
	await idle(ids);
	return (await events(ids)).filter((event) => event.seq > from && shown.has(event.type)).map(describeEvent);
};

const lastSeq = async (ids: Ids) => (await events(ids)).at(-1)?.seq ?? 0;

const releases = async (n: number) => {
	for (let step = 0; step < n; step++) await cw.release();
};

const snapshot = (name: string, artifact: unknown) => match(`recovery.machines.${name}`, artifact);

const describeMachines = available ? describe : describe.skip;

describeMachines("durable runs across real machine failures", () => {
	beforeAll(async () => {
		await ensure(cw.name);
		await cw.setup();
	}, 1_800_000);

	afterAll(async () => {
		await cw.net("fast").catch(() => undefined);
		await cw.net("restore").catch(() => undefined);
		await cw.stop("KILL").catch(() => undefined);
	}, 120_000);

	it("1. a host SIGKILLed mid-request is swept as a crash, resumed with one restart, and finishes", async () => {
		await fresh();
		const ids = await create();
		const steps: Array<{ step: string } & Awaited<ReturnType<typeof rows>>> = [];
		const record = async (step: string) => steps.push({ step, ...(await rows(ids)) });

		await prompt(ids, "gate");
		await inFlight(ids);
		await record("in flight");
		await cw.stop("KILL");
		await record("killed");

		await cw.start();
		await logged(ids, "session.execution.started", 2);
		await inFlight(ids);
		await record("resumed");
		expect(steps.at(-1)).toMatchObject({ restarts: 1, runState: "running" });
		// The resumed request is the scripted `gate` again: one step at once, four held.
		await releases(4);
		await logged(ids, "session.execution.succeeded");
		await idle(ids);
		await record("finished");

		expect(steps.at(-1)).toMatchObject({ restarts: 0, outcome: "succeeded" });
		const log = await lifecycle(ids);
		expect(log).toContain("session.execution.interrupted crash");
		expect(log).toContain("session.execution.started resumed=true");
		await snapshot("crash", { log, steps });
	}, 300_000);

	it("2. a machine shut down mid-request and booted again resumes the run, its queue intact", async () => {
		await fresh();
		const ids = await create();
		const steps: Array<{ step: string } & Awaited<ReturnType<typeof rows>>> = [];
		const record = async (step: string) => steps.push({ step, ...(await rows(ids)) });

		await prompt(ids, "gate");
		await inFlight(ids);
		await prompt(ids, "after the boot", { delivery: "followUp" });
		await record("in flight");

		const init = () => cw.sh("ps -o lstart= -p 1");
		const bootedAt = await init();
		await orb(["stop", cw.name], { timeout: 300_000 });
		const machines = JSON.parse(await orb(["list", "--format", "json"])) as Array<{ name: string; state: string }>;
		expect(machines.find((one) => one.name === cw.name)?.state).toBe("stopped");
		await orb(["start", cw.name], { timeout: 300_000 });
		expect(await init()).not.toBe(bootedAt);
		// A boot starts nothing: the server runs only once start.sh starts it.
		expect((await cw.sh(`pgrep -f '[f]ixtures/codework.ts' || true`)).trim()).toBe("");
		await cw.sh(`rm -f $HOME/cw.pid`);
		await record("booted");
		const ended = steps.at(-1)!.error as { reason?: string } | null;

		await cw.start();
		await reachable();
		await logged(ids, "session.execution.started", 2);
		await inFlight(ids);
		await record("resumed");
		await releases(4);
		await logged(ids, "session.execution.succeeded", 1, 120_000);
		await waitFor(async () => ((await queue(ids)).length === 0 ? true : undefined), "the follow-up to run", 120_000);
		await logged(ids, "session.execution.succeeded");
		await idle(ids);
		await record("finished");

		// A shutdown that published its own end resumes uncounted; one the OS cut off first is a crash.
		const reason = ended === null ? "crash" : ended.reason;
		expect(["shutdown", "crash"]).toContain(reason);
		expect(steps.find((step) => step.step === "resumed")).toMatchObject({
			restarts: reason === "shutdown" ? 0 : 1,
		});
		const finished = steps.at(-1)!;
		expect(finished).toMatchObject({ restarts: 0, outcome: "succeeded" });
		expect(finished.prompts.map((one) => [one.text, one.promoted !== null])).toEqual([
			["gate", true],
			["after the boot", true],
		]);
		await snapshot("shutdown", { reason, log: await lifecycle(ids), steps });
	}, 900_000);

	it("3. a user stop parks the queue: a SIGKILL and restart run nothing, the next prompt runs it all", async () => {
		await fresh();
		const ids = await create();
		const steps: Array<{ step: string } & Awaited<ReturnType<typeof rows>>> = [];
		const record = async (step: string) => steps.push({ step, ...(await rows(ids)) });

		await prompt(ids, "hold");
		await inFlight(ids);
		await prompt(ids, "after the stop", { delivery: "followUp" });
		await cw.run((rpc) => rpc["thread.interrupt"](ref(ids)));
		await logged(ids, "session.execution.interrupted");
		await idle(ids);
		await record("stopped");
		const stopped = steps.at(-1)!;
		expect(stopped.head).toBe("session.execution.interrupted user");
		expect(stopped.prompts.find((one) => one.text === "after the stop")).toMatchObject({ runnable: false });

		const before = await lastSeq(ids);
		await cw.stop("KILL");
		await cw.start();
		expect(await settledSince(ids, before)).toEqual([]);
		expect(await queue(ids)).toEqual(["after the stop"]);
		await record("restarted");

		await prompt(ids, "next");
		await waitFor(async () => ((await queue(ids)).length === 0 ? true : undefined), "the queue to run", 120_000);
		await idle(ids);
		await record("next prompt");
		const ran = (await lifecycle(ids)).filter((line) => line.startsWith("session.prompt.promoted"));
		// The parked follow-up and the new steer go in together, in the order they were sent.
		expect(ran).toEqual([
			'session.prompt.promoted steer "hold"',
			'session.prompt.promoted followUp "after the stop"',
			'session.prompt.promoted steer "next"',
		]);
		await snapshot("stop", { log: await lifecycle(ids), steps });
	}, 300_000);

	it("4. a host that keeps dying ends the run as a crash loop: its follow-up stays parked across another restart", async () => {
		await fresh();
		const ids = await create();
		const steps: Array<{ step: string } & Awaited<ReturnType<typeof rows>>> = [];
		const record = async (step: string) => steps.push({ step, ...(await rows(ids)) });

		await prompt(ids, "hold");
		await inFlight(ids);
		await prompt(ids, "parked by the loop", { delivery: "followUp" });
		// The first run, then a resume each until the limit: each dies with its request in flight.
		for (let started = 1; started <= Control.RESTART_LIMIT; started++) {
			await logged(ids, "session.llm.started", started);
			await inFlight(ids);
			await cw.stop("KILL");
			await cw.start();
		}
		await logged(ids, "session.run.failed");
		await idle(ids);
		await record("crash loop");
		const looped = steps.at(-1)!;
		expect(looped.error).toMatchObject({ _tag: "runFailed", reason: "crashloop" });
		expect(looped.head).toBe("session.run.failed crashloop");
		expect(looped.prompts.find((one) => one.text === "parked by the loop")).toMatchObject({ runnable: false });

		const before = await lastSeq(ids);
		await cw.stop("KILL");
		await cw.start();
		expect(await settledSince(ids, before)).toEqual([]);
		await record("restarted");

		await prompt(ids, "next");
		await waitFor(async () => ((await queue(ids)).length === 0 ? true : undefined), "the queue to run", 120_000);
		await idle(ids);
		await record("next prompt");
		expect(steps.at(-1)).toMatchObject({ restarts: 0, outcome: "succeeded" });
		const log = await lifecycle(ids);
		// One request per run that died, then one for the parked follow-up and the next prompt together.
		expect(count(await events(ids), "session.llm.started")).toBe(Control.RESTART_LIMIT + 1);
		await snapshot("crashloop", { log, steps });
	}, 900_000);

	it("5. a cut network leaves the run going; a retried prompt id lands once; the client catches up, also on a slow link", async () => {
		await fresh();
		const ids = await create();
		const steps: Array<{ step: string } & Awaited<ReturnType<typeof rows>>> = [];
		const record = async (step: string) => steps.push({ step, ...(await rows(ids)) });
		const sent = Session.SessionMessageSchema.ID.create();

		await prompt(ids, "gate", { id: sent });
		await inFlight(ids);
		await cw.net("cut");
		const unreachable = await cw
			.run((rpc) => rpc["thread.info"](ref(ids)))
			.then(
				() => false,
				() => true,
			);
		expect(unreachable).toBe(true);

		// Inside the machine, over loopback: a follow-up, and the held reply let through.
		await cw.drive([["thread.prompt", { ...ref(ids), text: "sent while cut", delivery: "followUp" }]]);
		await releases(4);
		await logged(ids, "session.execution.succeeded");
		await waitFor(
			async () => ((await rows(ids)).prompts.every((one) => one.promoted !== null) ? true : undefined),
			"the follow-up to run",
			120_000,
		);
		await record("cut");
		await cw.net("restore");

		// The client never heard back about its prompt before the cut; retrying it is the same prompt.
		await prompt(ids, "gate", { id: sent });
		await idle(ids);
		await record("retried");
		const log = await events(ids);
		expect(
			log.filter((event) => event.type === "session.prompt.admitted" && event.data["messageId"] === sent),
		).toHaveLength(1);
		expect(steps.at(-1)!.prompts).toEqual(steps.at(-2)!.prompts);

		const succeeded = count(await events(ids), "session.execution.succeeded");
		await cw.net("slow");
		await prompt(ids, "on a slow link");
		await logged(ids, "session.execution.succeeded", succeeded + 1);
		await idle(ids);
		const caught = await cw.run((rpc) =>
			rpc["session.log"]({ sessionId: Session.SessionSchema.ID.make(ids.sessionId) }).pipe(
				Stream.runCollect,
				Effect.map((items) => Array.from(items).filter((item) => item.type !== "log.synced").length),
			),
		);
		await cw.net("fast");
		await record("slow link");
		expect(caught).toBe((await events(ids)).length);
		await snapshot("network", { unreachable, log: await lifecycle(ids), steps });
	}, 600_000);
});
