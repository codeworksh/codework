/**
 * Background clones into host folders. Each is tracked by its destination from start until 30 seconds
 * after it is done (a failed or cancelled one stays until retried or discarded), and git's progress
 * is streamed as it arrives. Tracking is in memory: a restart forgets every clone.
 */
import { expandTilde } from "@codeworksh/harness/effect";
import {
	Cause,
	Clock,
	Context,
	Data,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Path,
	type PlatformError,
	PubSub,
	Queue,
	Ref,
	Schedule,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Contract } from "./contract.ts";

interface Interface {
	readonly start: (input: {
		readonly remote: string;
		readonly path: string;
	}) => Effect.Effect<{ readonly path: string; readonly remote: string }, Contract.HostError>;
	/** Interrupts a running clone and empties its folder. */
	readonly cancel: (path: string) => Effect.Effect<boolean>;
	readonly retry: (path: string) => Effect.Effect<boolean, Contract.HostError>;
	/** Stops tracking, interrupts a running clone and empties an unfinished folder. */
	readonly discard: (path: string) => Effect.Effect<void>;
	/** Refuses a session in a folder whose clone is running, failed or cancelled. */
	readonly guard: (path: string) => Effect.Effect<void, Contract.HostError>;
	readonly stream: Stream.Stream<ReadonlyArray<Contract.Clone>>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/clones/Service") {}

const DONE_RETENTION = "30 seconds";
// Git prints nothing while a transfer waits on the network, and the kernel can take 15+ minutes to
// give up on a dead connection; without this the last transfer speed shows as if data still arrived.
const STALL_AFTER = "20 seconds";
const DETAIL_MAX = 200;
const ERROR_MAX = 1000;
// Only the tail is read, and progress can be huge; lines keep flowing past the cap.
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PENDING_LINE = 64 * 1024;
const NOT_CLONED = "The repository could not be cloned.";
// Unexpected file system failures; matches the generic text clones report for them.
const UNCOMPLETED = "The source control operation could not be completed.";

const CLONE_ENV = {
	// Piped progress at once; credential prompts would hang without a tty.
	GIT_PROGRESS_DELAY: "0",
	GIT_TERMINAL_PROMPT: "0",
	// English progress without overriding LC_CTYPE, which a global post-checkout hook inherits.
	LANGUAGE: "C",
};

const clampText = (text: string, maxLength: number) =>
	text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const fail = (message: string) => new Contract.HostError({ message });

type Reason = "not_a_repository" | "conflict" | "authentication_failed" | "host_key_unverified";

class CloneError extends Data.TaggedError("CloneError")<{
	readonly message: string;
	readonly reason: Reason | null;
}> {}

// --- Progress --------------------------------------------------------------------------------

interface Progress {
	readonly stage: Contract.CloneStage;
	readonly percent: number | null;
	readonly detail: string | null;
}

const STAGE_PREFIXES: ReadonlyArray<readonly [RegExp, Contract.CloneStage]> = [
	[/^remote: Enumerating objects/, "counting"],
	[/^remote: Counting objects/, "counting"],
	[/^remote: Compressing objects/, "counting"],
	[/^Receiving objects/, "receiving"],
	[/^Resolving deltas/, "resolving"],
	[/^Updating files/, "checkout"],
	[/^Checking out files/, "checkout"],
];

const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$/;

/** One progress redraw; git separates them with a bare CR. */
const parseProgress = (line: string): Progress | null => {
	const trimmed = line.trim();
	const stageEntry = STAGE_PREFIXES.find(([pattern]) => pattern.test(trimmed));
	if (!stageEntry) return null;
	const stage = stageEntry[1];
	const match = PERCENT.exec(trimmed);
	if (!match) return { stage, percent: null, detail: null };
	const percent = Number(match[1]);
	const rawDetail = match[4]?.trim() ?? "";
	const detail = rawDetail.length > 0 && rawDetail !== "done." ? rawDetail : null;
	return {
		stage,
		percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
		detail,
	};
};

// --- URLs ------------------------------------------------------------------------------------

type Protocol = "ssh" | "https";

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
// Userinfo may contain `@`; the last one before the first slash separates the host.
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?([^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?([^@:/\s]+)(:\d+)?\/(.+)$/;

const parseCloneUrl = (url: string) => {
	const trimmed = url.trim();
	const ssh = SSH_URL.exec(trimmed);
	if (ssh) return { protocol: "ssh" as Protocol, host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
	const https = HTTPS_URL.exec(trimmed);
	if (https) return { protocol: "https" as Protocol, host: https[1]!, path: https[3]!, customPort: !!https[2] };
	const scp = SCP_LIKE_URL.exec(trimmed);
	if (scp) return { protocol: "ssh" as Protocol, host: scp[1]!, path: scp[2]!, customPort: false };
	return null;
};

/**
 * A clone URL in the other protocol, as the host may only have SSH keys or only an HTTPS credential
 * helper; null when it cannot be rewritten safely, such as with a custom port.
 */
const cloneUrlForProtocol = (url: string, protocol: Protocol): string | null => {
	const parsed = parseCloneUrl(url);
	if (!parsed) return null;
	if (parsed.protocol === protocol) return url.trim();
	if (parsed.customPort) return null;
	// Azure's transports use different hosts and put the repository marker in different positions;
	// changing only the scheme produces an invalid clone URL.
	if (parsed.protocol === "ssh" && parsed.host.toLowerCase() === "ssh.dev.azure.com") {
		const azure = /^v3\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(parsed.path);
		return azure ? `https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}` : null;
	}
	if (parsed.protocol === "https" && parsed.host.toLowerCase() === "dev.azure.com") {
		const azure = /^([^/?#]+)\/([^/?#]+)\/_git\/([^/?#]+)$/.exec(parsed.path);
		return azure ? `git@ssh.dev.azure.com:v3/${azure[1]}/${azure[2]}/${azure[3]}` : null;
	}
	return protocol === "ssh" ? `git@${parsed.host}:${parsed.path}` : `https://${parsed.host}/${parsed.path}`;
};

/** An SSH rejection is retried over HTTPS; other URL shapes are never guessed. */
const httpsFallbackUrl = (cloneUrl: string) =>
	parseCloneUrl(cloneUrl)?.protocol === "ssh" ? cloneUrlForProtocol(cloneUrl, "https") : null;

/** The remote as clients see it: git still gets the credentials. */
const redactRemoteUrl = (remoteUrl: string) => {
	const url = URL.parse(remoteUrl);
	// Clone URLs have no legitimate query; when one is present it is a token.
	if (url === null || (url.username.length === 0 && url.password.length === 0 && url.search.length === 0)) {
		return remoteUrl;
	}
	url.username = "";
	url.password = "";
	url.search = "";
	return url.toString();
};

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

const redactUrlCredentials = (text: string) =>
	text.replace(QUOTED_URL_QUERY, "$1$2$1").replace(URL_QUERY, "$1").replace(URL_WITH_USERINFO, "$1");

// --- Failure classification ------------------------------------------------------------------

// Only the reasons up to the two that switch to HTTPS matter, in git's order of precedence.
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, Reason]> = [
	[/would clobber existing tag/i, "conflict"],
	[/is already (?:used by worktree at|checked out at)/i, "conflict"],
	[/a branch named .+ already exists/i, "conflict"],
	[/could not lock config file .+: File exists/i, "conflict"],
	[
		/(?:authentication failed|could not read Username|could not read Password|permission denied \([a-z-]+(?:,[a-z-]+)*\)|permission denied, please try again)/i,
		"authentication_failed",
	],
	[/host key verification failed/i, "host_key_unverified"],
];

// Trust only git's diagnostic prefixes: local hooks can write indistinguishable text, and `remote:`
// prefixes remote hook output as well as server diagnostics.
const DIAGNOSTIC_LINE = /^(?:fatal|error):|^!\s|^\s+!\s/;
// SSH credential refusals are unprefixed; git's later generic error would otherwise hide them.
const SSH_TRANSPORT_REFUSAL =
	/Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|Host key verification failed/i;

const classify = (stderr: string): Reason | null => {
	const diagnostics = stderr
		.split(/\r?\n/)
		.filter((line) => DIAGNOSTIC_LINE.test(line) || (!line.startsWith("remote:") && SSH_TRANSPORT_REFUSAL.test(line)))
		.join("\n");
	if (diagnostics.length === 0) return null;
	if (diagnostics.toLowerCase().includes("not a git repository")) return "not_a_repository";
	return FAILURE_PATTERNS.find(([pattern]) => pattern.test(diagnostics))?.[1] ?? null;
};

const isSshRejection = (error: CloneError) =>
	error.reason === "authentication_failed" || error.reason === "host_key_unverified";

/**
 * Appends a git config entry through the environment, after any inherited ones, without touching
 * argv or the user's config; an invalid inherited count is left for git to report.
 */
const gitConfigEnv = (env: Record<string, string | undefined>, key: string, value: string) => {
	const inherited = env.GIT_CONFIG_COUNT;
	if (
		inherited !== undefined &&
		inherited !== "" &&
		/^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(inherited)?.[0] !== inherited
	) {
		return {};
	}
	const count = inherited === undefined || inherited === "" ? 0 : Number.parseInt(inherited, 10);
	return {
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: key,
		[`GIT_CONFIG_VALUE_${count}`]: value,
	};
};

const LINE_SEPARATOR = /\r\n|\r|\n/;

/** Reads a git output stream, keeping its first 256 KiB as text and passing every non-empty line on. */
const collect = Effect.fnUntraced(function* (
	stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
	onLine?: (line: string) => Effect.Effect<void>,
) {
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const lineDecoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	let pending = "";
	let truncated = false;

	const emit = Effect.fnUntraced(function* (flush: boolean) {
		if (onLine === undefined) return;
		let separator = LINE_SEPARATOR.exec(pending);
		while (separator) {
			const line = pending.slice(0, separator.index);
			pending = pending.slice(separator.index + separator[0].length);
			if (line.length > 0) yield* onLine(line);
			separator = LINE_SEPARATOR.exec(pending);
		}
		if (flush) {
			const trailing = pending;
			pending = "";
			if (trailing.length > 0) yield* onLine(trailing);
		}
	});

	yield* Stream.runForEach(
		stream,
		Effect.fnUntraced(function* (chunk) {
			if (!truncated) {
				const room = MAX_OUTPUT_BYTES - bytes;
				const kept = chunk.byteLength > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
				bytes += kept.byteLength;
				truncated = chunk.byteLength > room;
				text += decoder.decode(kept, { stream: !truncated });
			}
			if (onLine === undefined) return;
			pending += lineDecoder.decode(chunk, { stream: true });
			yield* emit(false);
			// A newline-free run that long is no use to anyone reading lines.
			if (truncated && pending.length > MAX_PENDING_LINE) pending = "";
		}),
	);
	if (!truncated) text += decoder.decode();
	pending += lineDecoder.decode();
	yield* emit(true);
	return text;
});

// --- Tracker ---------------------------------------------------------------------------------

interface Tracked {
	readonly snapshot: Contract.Clone;
	readonly fiber: Fiber.Fiber<unknown, unknown> | null;
	/** What git is given; may carry credentials and never leaves the server. */
	readonly cloneUrl: string;
}

const make = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const clones = yield* Ref.make(new Map<string, Tracked>());
	const changes = yield* PubSub.unbounded<ReadonlyArray<Contract.Clone>>();
	const retentionFibers = new Map<string, Fiber.Fiber<unknown, never>>();
	let sequence = 0;
	const cloneScope = yield* Scope.make("parallel");
	yield* Effect.addFinalizer(() => Scope.close(cloneScope, Exit.void));
	// Serialize actions on an entry and its folder so a retry cannot race a clone.
	const actionLock = yield* Semaphore.make(1);
	const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);

	const resolve = (value: string) => path.resolve(expandTilde(value.trim(), path));
	const failed = () => fail(UNCOMPLETED);

	const normalizeDestination = Effect.fn("Clones.normalizeDestination")(function* (destination: string) {
		if (destination.trim().length === 0) return yield* fail("Choose a destination path before cloning.");
		return resolve(destination);
	});

	const prepareDestination = Effect.fn("Clones.prepareDestination")(function* (input: string) {
		const destination = yield* normalizeDestination(input);
		if (yield* fs.exists(destination).pipe(Effect.mapError(failed))) {
			const entries = yield* fs
				.readDirectory(destination)
				.pipe(Effect.mapError(() => fail("Destination path already exists and is not a directory.")));
			if (entries.length > 0) return yield* fail("Destination path already exists and is not empty.");
		} else {
			const parent = path.dirname(destination);
			if (!(yield* fs.exists(parent).pipe(Effect.mapError(failed)))) {
				yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(failed));
			}
		}
		return destination;
	});

	const prepare = Effect.fn("Clones.prepare")(function* (input: { readonly remote: string; readonly path: string }) {
		const destination = yield* prepareDestination(input.path);
		const cloneUrl = input.remote.trim();
		if (cloneUrl.length === 0) return yield* fail("Enter a repository path or clone URL before cloning.");
		return { destination, cloneUrl, remote: redactRemoteUrl(cloneUrl) };
	});

	/** Empties a partial clone's folder, keeping the folder; refuses one holding files git did not write. */
	const discardClone = Effect.fn("Clones.discardClone")(function* (input: string) {
		const destination = yield* normalizeDestination(input);
		const entries = yield* fs.readDirectory(destination).pipe(
			Effect.catchIf(
				(error) => error.reason._tag === "NotFound",
				() => Effect.succeed<ReadonlyArray<string>>([]),
			),
			Effect.mapError(() => fail("The clone destination could not be inspected.")),
		);
		if (entries.length > 0 && !entries.includes(".git")) {
			return yield* fail("Destination path contains files that are not from the clone.");
		}
		// Retried while an interrupted git still closes its files.
		yield* fs.remove(destination, { recursive: true, force: true }).pipe(
			Effect.andThen(fs.makeDirectory(destination, { recursive: true })),
			Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
			Effect.mapError(() => fail("The partial clone could not be removed.")),
		);
	});

	const attempt = Effect.fn("Clones.attempt")(function* (
		destination: string,
		cloneUrl: string,
		onProgress: (update: Progress) => Effect.Effect<void>,
	) {
		// Git mixes progress and diagnostics on stderr; the last few other lines explain a failure.
		const tail: Array<string> = [];
		const onLine = (line: string) => {
			const parsed = parseProgress(line);
			if (parsed) return onProgress(parsed);
			return Effect.sync(() => {
				const trimmed = line.trim();
				if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
				// Git echoes the remote in some failures, and the tail is shown to the user.
				tail.push(redactUrlCredentials(trimmed));
				if (tail.length > 4) tail.shift();
			});
		};
		// Git misreads @ in a pathless URL's query as userinfo and echoes its suffix as the host.
		const normalized = cloneUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
		const base = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...CLONE_ENV };
		// A fake bare repository's config can run commands; git before 2.38 ignores this.
		const env = { ...base, ...gitConfigEnv(base, "safe.bareRepository", "explicit") };
		yield* Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make("git", ["clone", "--progress", "--", normalized, path.basename(destination)], {
					cwd: path.dirname(destination),
					env,
					extendEnv: false,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const [, stderr, exitCode] = yield* Effect.all(
				[collect(handle.stdout), collect(handle.stderr, onLine), handle.exitCode],
				{ concurrency: "unbounded" },
			);
			if (exitCode !== 0) return yield* new CloneError({ message: "", reason: classify(stderr) });
		}).pipe(
			Effect.scoped,
			Effect.mapError(
				(error) =>
					new CloneError({
						message: tail.length > 0 ? tail.join(" ") : NOT_CLONED,
						reason: error instanceof CloneError ? error.reason : null,
					}),
			),
		);
	});

	/** Clones over the URL as given, then over HTTPS when SSH was refused; the folder is not emptied in between. */
	const cloneRepository = Effect.fn("Clones.cloneRepository")(function* (
		input: string,
		cloneUrl: string,
		onProgress: (update: Progress) => Effect.Effect<void>,
	) {
		const destination = yield* prepareDestination(input);
		const httpsUrl = httpsFallbackUrl(cloneUrl);
		const first = attempt(destination, cloneUrl, onProgress);
		if (httpsUrl === null) return yield* first;
		yield* first.pipe(
			Effect.catchIf(isSshRejection, (sshError) =>
				attempt(destination, httpsUrl, onProgress).pipe(
					Effect.mapError(
						(httpsError) =>
							new CloneError({
								message: `${sshError.message} Cloning over HTTPS instead also failed: ${httpsError.message}`,
								reason: httpsError.reason,
							}),
					),
				),
			),
		);
	});

	const list = Ref.get(clones).pipe(
		Effect.map((current) => Array.from(current.values(), (tracked) => tracked.snapshot)),
	);
	const publish = list.pipe(Effect.flatMap((snapshots) => PubSub.publish(changes, snapshots)));

	const modify = (id: string, mutate: (tracked: Tracked) => Tracked) =>
		Ref.modify(clones, (current): readonly [Contract.Clone | null, Map<string, Tracked>] => {
			const existing = current.get(id);
			if (!existing) return [null, current];
			const nextTracked = mutate(existing);
			const nextSnapshot = { ...nextTracked.snapshot, sequence: ++sequence };
			const next = new Map(current);
			next.set(id, { ...nextTracked, snapshot: nextSnapshot });
			return [nextSnapshot, next];
		}).pipe(Effect.tap((snapshot) => (snapshot ? publish : Effect.void)));

	const clearRetention = (id: string) => {
		const fiber = retentionFibers.get(id);
		retentionFibers.delete(id);
		return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
	};

	const remove = (id: string) =>
		Ref.update(clones, (current) => {
			if (!current.has(id)) return current;
			const next = new Map(current);
			next.delete(id);
			return next;
		}).pipe(Effect.andThen(publish));

	const scheduleRemoval = Effect.fn("Clones.scheduleRemoval")(function* (id: string) {
		yield* clearRetention(id);
		const fiber: Fiber.Fiber<unknown> = yield* remove(id).pipe(
			Effect.delay(DONE_RETENTION),
			Effect.ensuring(
				Effect.sync(() => {
					if (retentionFibers.get(id) === fiber) retentionFibers.delete(id);
				}),
			),
			Effect.forkDetach,
		);
		retentionFibers.set(id, fiber);
	});

	const progress = (id: string, update: Progress) =>
		modify(id, (tracked) => ({
			...tracked,
			snapshot: {
				...tracked.snapshot,
				stage: update.stage,
				percent: update.percent,
				detail: update.detail === null ? null : clampText(update.detail, DETAIL_MAX),
				stalled: false,
			},
		})).pipe(Effect.asVoid);

	const markStalled = (id: string) =>
		modify(id, (tracked) => ({ ...tracked, snapshot: { ...tracked.snapshot, stalled: true } })).pipe(Effect.asVoid);

	/** Marks the clone stalled once, then waits for git to speak again. */
	const watchForStall = (id: string, pulses: Queue.Dequeue<void>) =>
		Queue.take(pulses).pipe(
			Effect.timeoutOption(STALL_AFTER),
			Effect.flatMap((pulse) =>
				Option.isSome(pulse) ? Effect.void : markStalled(id).pipe(Effect.andThen(Queue.take(pulses))),
			),
			Effect.forever,
		);

	const finish = Effect.fn("Clones.finish")(function* (
		id: string,
		phase: "done" | "failed" | "cancelled",
		error: string | null,
	) {
		const endedAt = yield* Clock.currentTimeMillis;
		yield* modify(id, (tracked) => ({
			...tracked,
			fiber: null,
			snapshot: {
				...tracked.snapshot,
				phase,
				endedAt,
				percent: phase === "done" ? 100 : tracked.snapshot.percent,
				stalled: false,
				error: error === null ? null : clampText(error, ERROR_MAX),
			},
		}));
		if (phase === "done") yield* scheduleRemoval(id);
	});

	const cloneWatchingForStall = Effect.fn("Clones.cloneWatchingForStall")(function* (id: string, tracked: Tracked) {
		const pulses = yield* Queue.sliding<void>(1);
		yield* watchForStall(id, pulses).pipe(Effect.forkScoped);
		return yield* cloneRepository(id, tracked.cloneUrl, (update) =>
			Queue.offer(pulses, undefined).pipe(Effect.andThen(progress(id, update))),
		);
	}, Effect.scoped);

	const describeFailure = (cause: Cause.Cause<unknown>) => {
		const error = Cause.squash(cause);
		return error instanceof Error && error.message.trim().length > 0 ? error.message : NOT_CLONED;
	};

	// `onExit` records the outcome even on interruption, which `matchCause` would skip.
	const runClone = (id: string, tracked: Tracked) =>
		cloneWatchingForStall(id, tracked).pipe(
			Effect.onExit((exit) =>
				Exit.isSuccess(exit)
					? finish(id, "done", null)
					: Cause.hasInterruptsOnly(exit.cause)
						? finish(id, "cancelled", null)
						: finish(id, "failed", describeFailure(exit.cause)),
			),
			Effect.ignoreCause(),
		);

	const launch = Effect.fn("Clones.launch")(function* (id: string) {
		const tracked = (yield* Ref.get(clones)).get(id);
		if (!tracked) return;
		const fiber = yield* runClone(id, tracked).pipe(Effect.forkIn(cloneScope));
		yield* Ref.update(clones, (map) => {
			const existing = map.get(id);
			if (!existing) return map;
			const next = new Map(map);
			next.set(id, { ...existing, fiber });
			return next;
		});
	});

	const get = (id: string) => Ref.get(clones).pipe(Effect.map((current) => current.get(id)?.snapshot ?? null));

	const start = Effect.fn("Clones.start")(function* (input: { readonly remote: string; readonly path: string }) {
		const prepared = yield* prepare(input);
		const id = prepared.destination;
		const snapshot: Contract.Clone = {
			path: id,
			remote: prepared.remote,
			phase: "running",
			stage: "connecting",
			percent: null,
			detail: null,
			stalled: false,
			error: null,
			startedAt: yield* Clock.currentTimeMillis,
			endedAt: null,
			sequence: ++sequence,
		};
		const claimed = yield* Ref.modify(clones, (current): readonly [boolean, Map<string, Tracked>] => {
			if (current.has(id)) return [false, current];
			const next = new Map(current);
			next.set(id, { snapshot, fiber: null, cloneUrl: prepared.cloneUrl });
			return [true, next];
		});
		if (!claimed) return yield* fail("A clone into this destination is already in progress.");
		// A claim without a fiber can be neither cancelled nor retried, so it finishes or is released despite disconnects.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* clearRetention(id);
				const created = () => fail("Failed to create the clone destination.");
				if (!(yield* fs.exists(id).pipe(Effect.mapError(created)))) {
					yield* fs.makeDirectory(id, { recursive: true }).pipe(Effect.mapError(created));
				}
				yield* publish;
				yield* launch(id);
			}).pipe(Effect.tapError(() => remove(id))),
		);
		return { path: id, remote: prepared.remote };
	});

	const cancel = Effect.fn("Clones.cancel")(function* (input: string) {
		const id = resolve(input);
		const tracked = (yield* Ref.get(clones)).get(id);
		if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) return false;
		const fiber = tracked.fiber;
		// Finished despite disconnects, so no running snapshot is left behind a dead fiber.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* Fiber.interrupt(fiber);
				const after = yield* get(id);
				if (after?.phase === "done") return;
				if (after?.phase === "running") yield* finish(id, "cancelled", null);
				yield* discardClone(id).pipe(Effect.ignore);
			}),
		);
		return true;
	});

	const retry = Effect.fn("Clones.retry")(function* (input: string) {
		const id = resolve(input);
		const tracked = (yield* Ref.get(clones)).get(id);
		if (!tracked || (tracked.snapshot.phase !== "failed" && tracked.snapshot.phase !== "cancelled")) return false;
		yield* discardClone(id);
		const startedAt = yield* Clock.currentTimeMillis;
		yield* modify(id, (entry) => ({
			...entry,
			snapshot: {
				...entry.snapshot,
				phase: "running",
				stage: "connecting",
				percent: null,
				detail: null,
				stalled: false,
				error: null,
				startedAt,
				endedAt: null,
			},
		}));
		yield* launch(id);
		return true;
	});

	const discard = Effect.fn("Clones.discard")(function* (input: string) {
		const id = resolve(input);
		const tracked = (yield* Ref.get(clones)).get(id);
		if (!tracked) return;
		if (tracked.fiber) yield* Fiber.interrupt(tracked.fiber);
		// Git may have finished while the interrupt landed; a complete checkout is the user's.
		const after = yield* get(id);
		if (after?.phase !== "done") yield* discardClone(id).pipe(Effect.ignore);
		yield* clearRetention(id);
		yield* remove(id);
	});

	const guard = Effect.fn("Clones.guard")(function* (input: string) {
		const clone = yield* get(resolve(input));
		if (clone === null || clone.phase === "done") return;
		return yield* fail(
			clone.phase === "running"
				? "The repository is still being cloned."
				: "The repository was not cloned. Retry the clone first.",
		);
	});

	const stream = Stream.callback<ReadonlyArray<Contract.Clone>>(
		(mailbox) =>
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(changes);
				Queue.offerUnsafe(mailbox, yield* list);
				yield* Stream.fromSubscription(subscription).pipe(
					Stream.runForEach((snapshots) => Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots))),
					Effect.forkScoped,
				);
			}),
		{ bufferSize: 1, strategy: "sliding" },
	);

	return Service.of({
		start: (input) => locked(start(input)),
		cancel: (path) => locked(cancel(path)),
		retry: (path) => locked(retry(path)),
		discard: (path) => locked(discard(path)),
		guard,
		stream,
	});
});

export const layer = Layer.effect(Service, make);

export * as Clones from "./clones.ts";
