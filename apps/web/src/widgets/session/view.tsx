import { ChevronRight, CircleDashed, Folder, X } from "@/components/vuesax";
import { RegistryContext, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { type HistoryEntry, type LiveDelta, Part, type QueuedPrompt, type ToolCall } from "@codeworksh/widget/codework";
import { useBus, useEvents, useFrame, useShell, type WidgetProps } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list/react";
import { createContext, memo, type ReactNode, use, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Logo } from "@/components/logo";
import { ComposerNotice, type Notice } from "@/components/banner";
import { useModelName, useModelsNotice } from "@/components/model";
import { threadAddress, threadRef } from "./address";
import { SessionComposer } from "./composer";
import { useFollow } from "./follow";
import { Markdown } from "./markdown";
import { menuThreads, useSettings } from "./menu";
import { Message } from "./message";
import { Queue } from "./queue";
import { ProjectSettings } from "./settings";
import { type Handoff, handoffs } from "./handoff";
import { type Display, displayLabel, usePendingPrompts, useRunDisplay, useSent } from "./display";
import { useNowSecond } from "../../hooks/now";
import { useStableCallback } from "../../hooks/stable";
import { useListedSession } from "./projects";
import { type Info, Json, type ThreadRef, threadKey, topics, type Update } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeForked = Schema.decodeUnknownOption(Json.Forked);
const encodeFork = Schema.encodeSync(Json.Fork);
const decodeWindow = Schema.decodeUnknownOption(Json.Window);
const decodeUpdate = Schema.decodeUnknownOption(Json.Update);
const samePart = Schema.toEquivalence(Part);

/** The composer overlay's height as last measured, by any conversation. */
let lastInset = 0;

/** Messages per page: the newest on open, then older ones as the reader scrolls up. */
const PAGE = 60;

// Shared reading width for the transcript and floating composer.
const contentWidth = "mx-auto w-full max-w-conversation";

export function Session({ address, instanceId }: WidgetProps<unknown>) {
	const thread = threadRef(address);
	const key = thread === undefined ? (address ?? "") : threadKey(thread);
	// The thread this frame showed before, so a switch can keep it in view while the next one loads.
	const [shown, setShown] = useState<{ readonly key: string; readonly previous?: string }>({ key });
	if (shown.key !== key) setShown({ key, previous: shown.key });
	useAtomMount(menuThreads);
	const [settings, setSettings] = useSettings(instanceId);
	if (thread === undefined) return <p className="p-3 text-ink-muted">Not a session: {address}</p>;
	// The thread stays mounted under its project's settings, so it comes back as it was left.
	return (
		<>
			<div hidden={settings} className="h-full">
				<Conversation key={key} thread={thread} instanceId={instanceId} previous={shown.previous} />
			</div>
			{settings && <ProjectSettings sessionId={thread.sessionId} onBack={() => setSettings(false)} />}
		</>
	);
}

type State =
	| { readonly status: "loading" }
	| { readonly status: "failed"; readonly message: string }
	| {
			readonly status: "ready";
			readonly info: Info;
			/** The loaded window of the conversation, oldest first. */
			readonly messages: readonly HistoryEntry[];
			/** Whether older messages remain to be paged in. */
			readonly more: boolean;
			/** Prompts sent but not yet in the conversation, oldest first. */
			readonly queued: readonly QueuedPrompt[];
			/** The first page's seq: updates are read from after it. */
			readonly after: number;
			/** Parts streamed into replies not in `messages` yet, by entry id; merged in once each lands. */
			readonly early?: ReadonlyMap<string, readonly Part[]>;
	  };

type Ready = Extract<State, { readonly status: "ready" }>;

const isRunning = (state: Ready) => state.info.runState !== "idle";

/*
 * The threads opened lately, as last shown: switching back to one renders it on the first frame
 * while it catches up, instead of an empty frame until its first page loads.
 */
const RECENT = 16;
const RECENT_FOR_MS = 5 * 60_000;
const recent = new Map<string, { readonly state: Ready; readonly at: number }>();

function remembered(key: string): State {
	const entry = recent.get(key);
	if (entry === undefined || Date.now() - entry.at > RECENT_FOR_MS) return { status: "loading" };
	return entry.state;
}

function remember(key: string, state: Ready) {
	recent.delete(key);
	recent.set(key, { state, at: Date.now() });
	for (const oldest of recent.keys()) {
		if (recent.size <= RECENT) break;
		recent.delete(oldest);
	}
}

/** How long a load runs before it says so, so a quick one never flashes a status line. */
const LOADING_AFTER_MS = 300;

/** What a failed run reads as: in the reader's words, never CodeWork's internal ids. */
const noticeOf = (kind: string, message: string): Notice => {
	switch (kind) {
		// The session's sandbox is gone, so it can't run; its conversation is still saved and readable.
		case "sandbox-mount-error":
			return {
				title: "Expired",
				description: "This session can't be picked up again. Start a new session to keep going.",
				tone: "expired",
			};
		default:
			return { title: "Something went wrong", description: message, tone: "error" };
	}
};

/** Whether `held` already has `part`'s text and more, streamed in after that checkpoint. */
const streamedPast = (held: Part, part: Part) =>
	(held.type === "text" &&
		part.type === "text" &&
		held.text.length > part.text.length &&
		held.text.startsWith(part.text)) ||
	(held.type === "thinking" &&
		part.type === "thinking" &&
		held.thinking.length > part.thinking.length &&
		held.thinking.startsWith(part.thinking));

const streamedText = (part: Part | undefined) =>
	part?.type === "text" ? part.text : part?.type === "thinking" ? part.thinking : undefined;

/**
 * `parts` with a delta folded in where it continues the held text exactly: at the held length, or
 * at 0 for a part not held yet, which it starts. Undefined drops it until the next checkpoint. A
 * part index past the held ones (a tool call between is not streamed) is padded with blank text.
 */
const foldDelta = (parts: readonly Part[], { partIndex, kind, offset, delta }: LiveDelta): Part[] | undefined => {
	const part = parts[partIndex];
	const held = streamedText(part);
	const starts = offset === 0 && (part === undefined || held === "");
	if (!starts && (part?.type !== kind || held?.length !== offset)) return undefined;
	const text = (starts ? "" : held) + delta;
	const next: Part =
		kind === "text"
			? { ...(part?.type === "text" ? part : { type: "text" as const }), text }
			: { ...(part?.type === "thinking" ? part : { type: "thinking" as const }), thinking: text };
	const padded = [...parts];
	while (padded.length < partIndex) padded.push({ type: "text", text: "" });
	padded[partIndex] = next;
	return padded;
};

const apply = (state: State, update: Update): State => {
	if (state.status !== "ready") return state;
	switch (update._tag) {
		case "Info":
			return { ...state, info: update.info };
		case "Queue":
			return { ...state, queued: update.queued };
		case "Delta": {
			const { entryId } = update.delta;
			const index = state.messages.findIndex((message) => message.id === entryId);
			const draft = state.messages[index];
			if (draft === undefined) {
				// The reply's row has not landed yet: its first deltas wait for it here.
				const parts = foldDelta(state.early?.get(entryId) ?? [], update.delta);
				return parts === undefined ? state : { ...state, early: new Map(state.early).set(entryId, parts) };
			}
			if (draft.state !== "draft") return state;
			const parts = foldDelta(draft.parts, update.delta);
			return parts === undefined ? state : { ...state, messages: state.messages.with(index, { ...draft, parts }) };
		}
		case "Message": {
			const { id } = update.message;
			const index = state.messages.findIndex((message) => message.id === id);
			const oldest = state.messages[0];
			// A message older than the window has not been paged in; its page will carry it.
			if (index === -1 && state.more && oldest !== undefined && update.message.seq < oldest.seq) return state;
			// A streamed draft can land just after the reply it belongs to ended; an ended reply stays ended.
			const previous = state.messages[index];
			if (previous !== undefined && update.message.state === "draft" && previous.state !== "draft") return state;
			// Unchanged parts keep their objects, so their rows skip re-rendering as the message streams.
			// A draft's checkpoint can trail the deltas already folded in, or that came before its row:
			// the longer text is the newer, and parts started since it was taken stay.
			const held = previous?.parts ?? state.early?.get(id);
			const streaming = update.message.state === "draft" && (previous === undefined || previous.state === "draft");
			const merged =
				held === undefined
					? update.message.parts
					: update.message.parts.map((part, at) => {
							const old = held[at];
							if (old === undefined) return part;
							return samePart(old, part) || (streaming && streamedPast(old, part)) ? old : part;
						});
			const message = {
				...update.message,
				parts: streaming && held !== undefined ? [...merged, ...held.slice(merged.length)] : merged,
			};
			let early = state.early;
			if (early?.has(id) === true) {
				const rest = new Map(early);
				rest.delete(id);
				early = rest;
			}
			return {
				...state,
				...(early === undefined ? {} : { early }),
				messages: previous === undefined ? [...state.messages, message] : state.messages.with(index, message),
				// Promoted: it is in the conversation now, whatever the next queue update says.
				queued: state.queued.some((prompt) => prompt.id === id)
					? state.queued.filter((prompt) => prompt.id !== id)
					: state.queued,
			};
		}
	}
};

const blank = (text: string) => text.trim() === "";

/** Whether `next` only grows text a draft already had: the same parts, each as blank as before. */
const streamedInto = (previous: HistoryEntry, next: HistoryEntry) =>
	previous.id === next.id &&
	previous.state === "draft" &&
	next.state === "draft" &&
	previous.error === next.error &&
	previous.parts.length === next.parts.length &&
	previous.parts.every((part, at) => {
		const other = next.parts[at]!;
		if (part === other) return true;
		if (part.type === "text" && other.type === "text") return blank(part.text) === blank(other.text);
		return (
			part.type === "thinking" &&
			other.type === "thinking" &&
			part.redacted === other.redacted &&
			blank(part.thinking) === blank(other.thinking)
		);
	});

/** Whether `next` differs from `previous` only by text streamed into its drafts. */
const sameStructure = (previous: State, next: State) =>
	previous === next ||
	(previous.status === "ready" &&
		next.status === "ready" &&
		previous.info === next.info &&
		previous.more === next.more &&
		previous.queued === next.queued &&
		previous.after === next.after &&
		previous.messages.length === next.messages.length &&
		previous.messages.every(
			(message, at) => message === next.messages[at] || streamedInto(message, next.messages[at]!),
		));

/**
 * A conversation as it streams. `quiet` holds while only a draft's text grows, so the transcript
 * re-renders on structure alone; a streaming row reads its own text through `message`.
 */
function conversationStore(initial: State) {
	const live = Atom.make<State>(initial);
	const quiet = Atom.make((get) => get(live)).pipe(Atom.withEquality(sameStructure));
	const message = Atom.family((id: string) =>
		Atom.make((get) => {
			const state = get(live);
			return state.status === "ready" ? state.messages.find((entry) => entry.id === id) : undefined;
		}),
	);
	return { live, quiet, message };
}

/** Forks the conversation at an entry; one identity for the conversation's life, so no turn renders for it. */
const ForkContext = createContext<(entry: HistoryEntry) => void>(() => {});

/** An entry a fork can start at: committed, so its place in the line is final. */
const forkable = (entry: HistoryEntry | undefined): entry is HistoryEntry => entry?.state === "committed";

const noMessage = Atom.make<HistoryEntry | undefined>(undefined);
const StreamedContext = createContext<(id: string) => Atom.Atom<HistoryEntry | undefined>>(() => noMessage);

/** A reply's answer (its text parts, as one), or the text of its part `at`. */
function textOf(reply: HistoryEntry, at?: number) {
	if (at === undefined) return reply.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
	const part = reply.parts[at];
	return part?.type === "thinking" ? part.thinking : part?.type === "text" ? part.text : "";
}

/**
 * `textOf` a reply as it streams: a draft reads its live message, so a streamed update re-renders
 * only the row showing it. A settled reply, or one this conversation does not hold, reads as given.
 */
function useStreamed(reply: HistoryEntry, at?: number) {
	const message = use(StreamedContext);
	const select = (entry: HistoryEntry | undefined) => (entry === undefined ? undefined : textOf(entry, at));
	return useAtomValue(reply.state === "draft" ? message(reply.id) : noMessage, select) ?? textOf(reply, at);
}

/**
 * Asks the session backend to follow the thread, loads its newest page, then applies every update
 * published after that page. Older pages load on demand. A dropped connection resumes where it
 * left off.
 */
function useConversation(thread: ThreadRef) {
	const bus = useBus();
	const registry = use(RegistryContext);
	const [store] = useState(() => conversationStore(remembered(threadKey(thread))));
	const state = useAtomValue(store.quiet);
	const setState = useAtomSet(store.live);
	const paging = useRef(false);

	// As last streamed, not as last quiet: the next thread's first render may stand this one in.
	useEffect(
		() =>
			registry.subscribe(store.live, (latest) => {
				if (latest.status === "ready") remember(threadKey(thread), latest);
			}),
		[registry, store, thread],
	);

	const page = async (before: number | undefined) => {
		const reply = decodeWindow(
			(
				await bus.request({
					topic: topics.page,
					payload: { ...thread, limit: PAGE, ...(before === undefined ? {} : { before }) },
				})
			).payload,
		);
		return Option.getOrUndefined(reply);
	};

	useEffect(() => {
		let active = true;
		const fail = (message: string) => {
			if (active) setState({ status: "failed", message });
		};
		void (async () => {
			const reply = decodeReply((await bus.request({ topic: topics.follow, payload: thread })).payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") return fail(reply.value.message);
			const window = await page(undefined);
			if (window === undefined) return fail(`Could not load session ${threadKey(thread)}.`);
			if (window._tag === "Failed") return fail(window.message);
			const { info, messages, more, queued, seq } = window;
			if (active) setState({ status: "ready", info, messages, more, queued, after: seq });
		})().catch(() => fail("The CodeWork server is not reachable."));
		return () => {
			active = false;
		};
	}, [bus, thread, page]);

	const after = state.status === "ready" ? state.after : undefined;
	// Updates that arrive within a frame apply together, in one render, instead of one render each.
	const pending = useRef<Update[]>([]);
	const scheduled = useRef<() => void>(undefined);
	useEffect(() => () => scheduled.current?.(), []);
	useEvents(after === undefined ? undefined : { topics: [topics.thread(threadKey(thread))], after }, (item) => {
		if ("_tag" in item) return;
		const update = decodeUpdate(item.payload);
		if (Option.isNone(update)) return;
		pending.current.push(update.value);
		if (scheduled.current !== undefined) return;
		const run = () => {
			scheduled.current = undefined;
			const batch = pending.current;
			pending.current = [];
			setState((current) => batch.reduce(apply, current));
		};
		// A hidden window gets no animation frames, so updates still land, just less often.
		if (document.hidden) {
			const timer = setTimeout(run, 50);
			scheduled.current = () => clearTimeout(timer);
		} else {
			const frame = requestAnimationFrame(run);
			scheduled.current = () => cancelAnimationFrame(frame);
		}
	});

	const oldest = state.status === "ready" && state.more ? state.messages[0]?.seq : undefined;
	const loadOlder = () => {
		if (oldest === undefined || paging.current) return;
		paging.current = true;
		void page(oldest)
			.then((window) => {
				if (window?._tag !== "Window") return;
				setState((current) => {
					if (current.status !== "ready") return current;
					const known = new Set(current.messages.map((message) => message.id));
					const older = window.messages.filter((message) => !known.has(message.id));
					return { ...current, messages: [...older, ...current.messages], more: window.more };
				});
			})
			.finally(() => {
				paging.current = false;
			});
	};

	return { state, loadOlder, message: store.message };
}

/** A sent prompt as the conversation shows it until the backend echoes it. */
const standIn = (thread: ThreadRef, prompt: Handoff): HistoryEntry => ({
	id: prompt.id,
	threadId: thread.threadId ?? thread.sessionId,
	seq: Number.MAX_SAFE_INTEGER,
	role: "user",
	state: "committed",
	createdAt: prompt.createdAt,
	updatedAt: prompt.createdAt,
	parts: [{ type: "text", text: prompt.text }],
	size: 0,
});

function Conversation({
	thread,
	instanceId,
	previous,
}: {
	readonly thread: ThreadRef;
	readonly instanceId: string;
	/** The thread shown before this one; its last state stands in, inert, while this one loads. */
	readonly previous: string | undefined;
}) {
	const { setTitle, setIcon, setTab } = useFrame();
	const { state: loaded, loadOlder, message } = useConversation(thread);
	const slow = useSlow(loaded.status === "loading");
	// Prompts sent while idle, shown before the backend echoes them: it queues a prompt before the
	// conversation takes it in, which would otherwise flash a queue row. Each leaves once echoed.
	// The start page's first prompt arrives the same way, handed over with the new session.
	const [sent, setSent] = useState<readonly HistoryEntry[]>(() => {
		const handoff = thread.threadId === undefined ? handoffs.get(thread.sessionId) : undefined;
		return handoff === undefined ? [] : [standIn(thread, handoff)];
	});
	useEffect(() => void handoffs.delete(thread.sessionId), [thread.sessionId]);
	if (loaded.status === "ready" && sent.length > 0) {
		const echoed = new Set(loaded.messages.map((message) => message.id));
		if (sent.some((message) => echoed.has(message.id))) setSent(sent.filter((message) => !echoed.has(message.id)));
	}
	// A run that stops or fails before taking a prompt in leaves it queued for the next wake: its
	// stand-in goes, so the queue row and its actions show again.
	const run = loaded.status === "ready" ? loaded : undefined;
	const failure = run?.info.failure;
	const outcome = `${run?.info.runState}|${failure?.kind ?? ""}|${failure?.message ?? ""}`;
	const [seenOutcome, setSeenOutcome] = useState(outcome);
	if (outcome !== seenOutcome) {
		setSeenOutcome(outcome);
		if (sent.length > 0 && (run?.info.runState === "idle" || failure !== undefined)) setSent([]);
	}
	let state: State = loaded;
	if (loaded.status === "ready" && sent.length > 0) {
		const ids = new Set(sent.map((message) => message.id));
		state = {
			...loaded,
			messages: [...loaded.messages, ...sent],
			queued: loaded.queued.some((prompt) => ids.has(prompt.id))
				? loaded.queued.filter((prompt) => !ids.has(prompt.id))
				: loaded.queued,
		};
	}
	const sending = (prompt: Handoff) => setSent((current) => [...current, standIn(thread, prompt)]);
	// A prompt this window sent is pending until it lands in app.db, as a message or a queued prompt.
	const key = threadKey(thread);
	const inFlight = usePendingPrompts(key);
	const { landed, forget, stop } = useSent();
	// A stop CodeWork accepted, from any window or before a reload, shows as this window's own until the run ends.
	const stopAccepted = loaded.status === "ready" && loaded.info.stopping;
	useEffect(() => {
		if (stopAccepted) stop(key);
	}, [stopAccepted, key, stop]);
	useEffect(() => {
		if (loaded.status !== "ready" || inFlight.size === 0) return;
		const known = new Set([...loaded.messages, ...loaded.queued].map((item) => item.id));
		landed(
			key,
			[...inFlight].filter((id) => known.has(id)),
		);
	}, [loaded, inFlight, key, landed]);
	// Only this view hears the thread's rows land, so what it sent goes with it.
	useEffect(() => () => forget(key), [key, forget]);
	const phase = useRunDisplay([{ key, runState: loaded.status === "ready" ? loaded.info.runState : "idle" }]);
	const unsent = (id: string) => setSent((current) => current.filter((message) => message.id !== id));
	// A fork opens in a frame of its own once the backend answers, by then in app.db.
	const bus = useBus();
	const shell = useShell();
	const [forkError, setForkError] = useState<string>();
	const forkAt = useStableCallback((entry: HistoryEntry) => {
		// A prompt this window sent and app.db holds only as a stand-in has no place to fork at yet.
		if (sent.some((message) => message.id === entry.id)) return;
		setForkError(undefined);
		void bus
			.request({ topic: topics.fork, payload: encodeFork({ ...thread, entryId: entry.id }) })
			.then((reply) => Option.getOrUndefined(decodeForked(reply.payload)))
			.catch(() => undefined)
			.then((forked) => {
				if (forked?._tag === "Forked")
					shell.open(threadAddress({ sessionId: thread.sessionId, threadId: forked.threadId }), { mode: "new" });
				else setForkError(forked?.message ?? "The CodeWork server is not reachable.");
			});
	});
	// Named from the sessions list at once, so the frame never shows its default title while loading.
	const listed = useListedSession(thread.sessionId);
	const title = state.status === "ready" ? state.info.title : listed?.title;
	// The list follows a rename; the loaded thread keeps the name it was opened with.
	const project = listed?.project ?? (state.status === "ready" ? state.info.project : undefined);
	const projectName = project?.name;

	const [settings] = useSettings(instanceId);
	useEffect(() => {
		if (settings) {
			setTitle("Settings", projectName);
			setTab(projectName === undefined ? "Settings" : `${projectName} / Settings`);
			return;
		}
		if (title === undefined) return;
		// The project leads, so sessions from different projects tell apart at a glance.
		setTitle(title, projectName);
		// The project's folder icon, as in the sessions sidebar. The run's state shows on the workspace's tab
		// just above, so the frame does not repeat it.
		if (projectName !== undefined) setIcon(<Folder size={14} className="shrink-0 text-ink-muted" aria-hidden />);
		// While focused, the workspace's tab reads as this session: its project, then its title.
		setTab(projectName === undefined ? title : `${projectName} / ${title}`);
	}, [settings, title, projectName, setTitle, setIcon, setTab]);

	// Models that can't be listed first: a state that clears itself, so it can't be dismissed. Then a
	// refused send, else why the last run failed; dismissing hides that one notice only.
	const models = useModelsNotice(state.status === "ready" ? state.info.hostDir : undefined);
	const [sendError, setSendError] = useState<string>();
	// A queued prompt taken back to edit; the composer puts its text above the draft.
	const [restored, setRestored] = useState<{ readonly text: string; readonly key: number }>();
	const restore = (text: string) => setRestored((current) => ({ text, key: (current?.key ?? 0) + 1 }));
	const [dismissed, setDismissed] = useState<Notice>();
	const notice: Notice | undefined =
		sendError !== undefined
			? { title: "Not sent", description: sendError, tone: "error" }
			: forkError !== undefined
				? { title: "Not forked", description: forkError, tone: "error" }
				: state.status === "ready" && state.info.failure !== undefined
					? noticeOf(state.info.failure.kind, state.info.failure.message)
					: undefined;
	const shown =
		notice !== undefined && (dismissed?.title !== notice.title || dismissed.description !== notice.description);

	const surface = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLDivElement>(null);
	// The last composer's height, so a conversation opens at its end with the composer already
	// counted and the list does not scroll again once it is measured.
	const [inset, setInset] = useState(lastInset);
	// Before paint, so the first frame is laid out with the composer's height.
	useLayoutEffect(() => {
		const root = surface.current;
		const element = composer.current;
		if (root === null || element === null) return;
		const sync = () => {
			const height = element.getBoundingClientRect().height;
			root.querySelector<HTMLElement>(".session-transcript")?.style.setProperty("--composer-height", `${height}px`);
			lastInset = Math.ceil(height);
			setInset(lastInset);
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(element);
		return () => observer.disconnect();
	}, [state.status]);

	// A thread not shown lately keeps the one before it in view, inert, for a quick load.
	const stand =
		state.status === "loading" && !slow && previous !== undefined ? recent.get(previous)?.state : undefined;
	const view = stand ?? state;
	if (view.status === "loading") return <Loading slow={slow} />;
	if (view.status === "failed") return <p className="p-3 text-ink-muted">{view.message}</p>;
	const running = isRunning(view);
	return (
		<div ref={surface} inert={stand !== undefined} className="relative flex h-full flex-col">
			<StreamedContext value={message}>
				<ForkContext value={forkAt}>
					<Transcript
						key={stand === undefined ? "own" : "stand"}
						state={view}
						running={running}
						phase={stand === undefined ? phase : view.info.runState}
						loadOlder={loadOlder}
						inset={inset}
					/>
				</ForkContext>
			</StreamedContext>
			<div
				ref={composer}
				className={`${contentWidth} pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-3 *:pointer-events-auto`}
			>
				{models !== undefined ? (
					<ComposerNotice {...models} />
				) : (
					shown && (
						<ComposerNotice
							{...notice}
							onDismiss={() => {
								setDismissed(notice);
								setSendError(undefined);
								setForkError(undefined);
							}}
						/>
					)
				)}
				{/* Idle too: prompts left waiting by a stop or a failure run with the next message, so they stay in view. */}
				{view.queued.length > 0 && (
					<Queue
						thread={thread}
						queued={view.queued}
						running={running}
						parked={view.info.parked}
						onError={setSendError}
						onRestore={restore}
					/>
				)}
				<SessionComposer
					thread={thread}
					instanceId={instanceId}
					running={running}
					stopping={phase === "stopping"}
					info={view.info}
					onError={setSendError}
					onSending={sending}
					onUnsent={unsent}
					restored={restored}
				/>
			</div>
		</div>
	);
}

/** True once something has been loading for a while, so a quick load never flashes a status line. */
function useSlow(loading: boolean) {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		if (!loading) return;
		const timer = setTimeout(() => setSlow(true), LOADING_AFTER_MS);
		return () => clearTimeout(timer);
	}, [loading]);
	return loading && slow;
}

/** The frame while a thread it hasn't shown lately loads: empty, then a quiet line if it takes a while. */
function Loading({ slow }: { readonly slow: boolean }) {
	return (
		<div className="flex h-full items-center justify-center text-xs text-ink-muted">
			{slow && (
				<span className="transition-opacity duration-150 ease-out starting:opacity-0">Loading messages…</span>
			)}
		</div>
	);
}

const turnKey = (turn: Turn) => turn.user?.id ?? turn.replies[0]?.id ?? "empty";

// LegendList averages sizes by type; length buckets prevent inflated estimates and nested-update loops.
function turnType(turn: Turn) {
	const length =
		(turn.user === undefined ? 0 : textOf(turn.user).length) +
		turn.replies.reduce((sum, reply) => sum + textOf(reply).length, 0);
	return `turn:${Math.max(0, Math.floor(Math.log2(length / 1000)))}`;
}

const PROMPT_JUST_SENT_MS = 1500;
const PROMPT_RECENT_MS = 5000;

const TRANSCRIPT_HEADER = <div className="h-5" />;
const MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true };

/**
 * The conversation as a list of turns. Sending a prompt anchors the new turn to the top of the
 * viewport, so older turns scroll above the screen unless the reader scrolls up.
 */
function Transcript({
	state,
	running,
	phase,
	loadOlder,
	inset,
}: {
	readonly state: Ready;
	readonly running: boolean;
	/** The run as drawn: the stored run state joined by a prompt or stop on its way. */
	readonly phase: Display;
	readonly loadOlder: () => void;
	/** The composer overlay's height. */
	readonly inset: number;
}) {
	const [scrolled, setScrolled] = useState(false);
	const modelName = useModelName(state.info.hostDir, state.info.model);
	const turns = useTurns(state.messages);
	const lastUser = turns.at(-1)?.user;
	// oxlint-disable-next-line react/purity -- useFollow reads what this decides on mount only.
	const sentAgo = lastUser === undefined ? Infinity : Date.now() - lastUser.createdAt;
	const { ref, onLoad, onScroll, anchoredEndSpace, maintainScrollAtEnd, pending, settled } = useFollow({
		lastUserId: lastUser?.id,
		anchored: running || sentAgo < PROMPT_RECENT_MS,
		// The start page's first prompt, handed over with the new session.
		rise: running && turns.length === 1 && sentAgo < PROMPT_JUST_SENT_MS,
		running,
		inset,
		anchorIndex: (promptId) => turns.findLastIndex((turn) => turn.user?.id === promptId),
	});
	const extraData = { phase, modelName, pending };

	if (turns.length === 0)
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-3">
				<p className="text-center text-body text-ink-muted">Send a message to start the conversation.</p>
			</div>
		);
	const renderItem = ({ item, index }: LegendListRenderItemProps<Turn>) => (
		<TurnView
			turn={item}
			phase={index === turns.length - 1 ? phase : "idle"}
			pending={item.user !== undefined && item.user.id === pending}
			modelName={modelName}
		/>
	);
	const transcriptRef = (instance: LegendListRef | null) => {
		instance?.getScrollableNode().style.setProperty("--composer-height", `${inset}px`);
		return ref(instance);
	};
	return (
		<LegendList<Turn>
			ref={transcriptRef}
			data={turns}
			extraData={extraData}
			keyExtractor={turnKey}
			getItemType={turnType}
			renderItem={renderItem}
			estimatedItemSize={90}
			recycleItems={false}
			initialScrollAtEnd
			onLoad={onLoad}
			{...(anchoredEndSpace === undefined ? {} : { anchoredEndSpace })}
			contentInsetEndAdjustment={anchoredEndSpace === undefined ? 0 : inset}
			maintainScrollAtEnd={maintainScrollAtEnd}
			maintainScrollAtEndThreshold={1}
			maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
			onStartReached={state.more ? loadOlder : undefined}
			onScroll={(event) => {
				onScroll();
				setScrolled(event.nativeEvent.contentOffset.y > 1);
			}}
			tabIndex={0}
			aria-label="Conversation"
			data-settled={settled}
			className={`session-transcript min-h-0 flex-1 overflow-x-hidden overscroll-y-contain [overflow-anchor:none] ${scrolled ? "session-transcript-scrolled" : ""} ${settled ? "" : "invisible"}`}
			ListHeaderComponent={TRANSCRIPT_HEADER}
			ListFooterComponent={<div aria-hidden style={{ height: (anchoredEndSpace === undefined ? inset : 0) + 24 }} />}
		/>
	);
}

/** A user message and the agent's replies to it, up to the next user message. */
interface Turn {
	readonly user: HistoryEntry | undefined;
	readonly replies: readonly HistoryEntry[];
}

// Messages are the same objects unless they changed, so an unchanged turn keeps its object too.
const sameMessages = (a: Turn, b: Turn) =>
	a.user === b.user &&
	a.replies.length === b.replies.length &&
	a.replies.every((reply, index) => reply === b.replies[index]);

function turnsOf(entries: readonly HistoryEntry[], previous: readonly Turn[]): Turn[] {
	const turns: { user: HistoryEntry | undefined; replies: HistoryEntry[] }[] = [];
	for (const entry of entries) {
		const current = turns.at(-1);
		if (entry.role === "user" || current === undefined) turns.push({ user: undefined, replies: [] });
		const turn = turns.at(-1)!;
		if (entry.role === "user") turn.user = entry;
		else turn.replies.push(entry);
	}
	const known = new Map(previous.map((turn) => [turnKey(turn), turn]));
	return turns.map((turn) => {
		const old = known.get(turnKey(turn));
		return old !== undefined && sameMessages(old, turn) ? old : turn;
	});
}

/** Turns rebuilt on every structural update, keeping the objects of those that didn't change. */
function useTurns(messages: readonly HistoryEntry[]) {
	const [state, setState] = useState(() => ({ messages, turns: turnsOf(messages, []) }));
	if (state.messages === messages) return state.turns;
	const turns = turnsOf(messages, state.turns);
	setState({ messages, turns });
	return turns;
}

interface TurnProps {
	readonly turn: Turn;
	/** The run as drawn, for the last turn; idle for every other. */
	readonly phase: Display;
	/** Hidden until its prompt rises into its anchor. */
	readonly pending: boolean;
	readonly modelName: string | undefined;
}

const sameTurn = (a: TurnProps, b: TurnProps) =>
	a.turn === b.turn && a.phase === b.phase && a.pending === b.pending && a.modelName === b.modelName;

/**
 * What the work log can show: a tool call, readable thinking, or a note between calls. Thinking a
 * provider withholds (redacted, or reasoning sent without a summary) has nothing to show.
 */
const isWork = (part: Part) =>
	part.type === "toolCall" ||
	(part.type === "thinking" && part.redacted !== true && part.thinking.trim() !== "") ||
	(part.type === "text" && part.text.trim() !== "");

/**
 * The answer is the last reply's text; everything before it (thinking, tool calls, notes between
 * calls) is the work that led there, folded under one line.
 */
const TurnView = memo(function TurnView({ turn, phase, pending, modelName }: TurnProps) {
	const active = phase !== "idle";
	const last = turn.replies.at(-1);
	const answer = last?.parts.some((part) => part.type === "text") === true;
	const work = turn.replies.flatMap((reply) =>
		reply.parts.flatMap((part, at) =>
			(reply === last && part.type === "text") || !isWork(part) ? [] : [{ part, reply, at }],
		),
	);
	const interrupted = last?.state === "aborted";
	const failed = last?.error !== undefined;
	// While the agent works and no final answer is streaming yet (or a tool is still running), keep the work open.
	const toolRunning = work.some(
		({ part }) => part.type === "toolCall" && (part.status === "pending" || part.status === "running"),
	);
	const working = active && (last?.state !== "draft" || !answer || toolRunning);
	const started = turn.user?.createdAt ?? turn.replies[0]?.createdAt;
	const forkAt = use(ForkContext);
	const user = turn.user;
	const ended = active ? undefined : endOf(turn.replies);

	return (
		<section
			data-prompt-pending={pending || undefined}
			className={`transcript-turn ${contentWidth} flex flex-col pt-2 pb-2 text-body`}
		>
			{user !== undefined && <UserMessage entry={user} onFork={forkable(user) ? () => forkAt(user) : undefined} />}
			{(work.length > 0 || working || answer || interrupted || failed) && (
				<Message
					role="assistant"
					at={turn.replies[0]?.createdAt}
					ended={ended}
					copyText={last === undefined ? "" : textOf(last)}
					onFork={forkable(last) ? () => forkAt(last) : undefined}
				>
					<WorkLog
						steps={work}
						started={started}
						ended={ended}
						working={working}
						phase={phase}
						modelName={modelName}
					/>
					{answer && last !== undefined && <Answer reply={last} />}
					{last?.error !== undefined ? (
						<p className="px-4 py-1 text-xs text-destructive">{last.error}</p>
					) : (
						interrupted && <p className="px-4 py-1 text-xs text-ink-muted">Interrupted</p>
					)}
				</Message>
			)}
		</section>
	);
}, sameTurn);

function Answer({ reply }: { readonly reply: HistoryEntry }) {
	const text = useStreamed(reply);
	return (
		<div className="min-w-0 px-4 pt-1 pb-1">
			<Markdown text={text} streaming={reply.state === "draft"} />
		</div>
	);
}

function UserMessage({ entry, onFork }: { readonly entry: HistoryEntry; readonly onFork: (() => void) | undefined }) {
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const textRef = useRef<HTMLParagraphElement>(null);
	const text = entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
	const images = entry.parts.filter((part) => part.type === "image").length;
	useEffect(() => {
		const element = textRef.current;
		if (element === null || text === "") {
			setOverflows(false);
			return;
		}
		const measure = () => {
			if (!expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [text, expanded]);
	return (
		<Message role="user" promptId={entry.id} at={entry.createdAt} copyText={text} onFork={onFork}>
			{text !== "" && (
				<p
					ref={textRef}
					className={`min-w-0 whitespace-pre-wrap wrap-break-word ${expanded ? "" : "line-clamp-4"}`}
				>
					{text}
				</p>
			)}
			{overflows && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="mt-1 rounded-sm px-1 py-0.5 text-xs text-message-ink/65 transition-[transform,background-color,color] duration-150 ease-out hover:bg-message-ink/10 hover:text-message-ink active:scale-[0.97]"
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
			{images > 0 && <p className="text-xs text-message-ink/65">{images === 1 ? "1 image" : `${images} images`}</p>}
		</Message>
	);
}

/** When a settled turn ended: its last reply's last change, or a tool's last update if later. */
function endOf(replies: readonly HistoryEntry[]) {
	return Math.max(
		0,
		...replies.flatMap((reply) => [
			reply.updatedAt,
			...reply.parts.flatMap((part) => (part.type === "toolCall" && part.time ? [part.time.end] : [])),
		]),
	);
}

function formatElapsed(elapsedMs: number | undefined): string | undefined {
	if (elapsedMs === undefined || elapsedMs < 0) return undefined;
	const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatWorkingDuration(elapsedMs: number | undefined, modelName: string | undefined, done: boolean): string {
	const who = modelName?.trim();
	const elapsed = formatElapsed(elapsedMs);
	const verb = done ? (who ? "worked" : "Worked") : who ? "working" : "Working";
	if (elapsed === undefined) {
		if (done) return who ? `${who} ${verb}` : verb;
		return who ? `${who} ${verb}…` : `${verb}…`;
	}
	return who ? `${who} ${verb} for ${elapsed}` : `${verb} for ${elapsed}`;
}

function WorkLabel({
	started,
	ended,
	phase,
	modelName,
}: {
	readonly started: number | undefined;
	readonly ended: number | undefined;
	readonly phase: Display;
	readonly modelName: string | undefined;
}) {
	// Before the run takes the prompt in, and while a stop reaches it, the state says more than the time.
	if (phase === "pending" || phase === "starting" || phase === "stopping") return `${displayLabel[phase]}…`;
	if (ended === undefined) return <LiveWorkLabel started={started} modelName={modelName} />;
	return formatWorkingDuration(
		started !== undefined && ended >= started ? ended - started : undefined,
		modelName,
		true,
	);
}

// A leaf of its own, so the second tick re-renders only the label's text.
function LiveWorkLabel({
	started,
	modelName,
}: {
	readonly started: number | undefined;
	readonly modelName: string | undefined;
}) {
	const now = useNowSecond();
	return formatWorkingDuration(started === undefined ? undefined : Math.max(0, now - started), modelName, false);
}

/** Flags the edges with more to scroll to, so only those fade. */
function markScrollEdges(el: HTMLElement) {
	const below = el.scrollHeight - el.clientHeight - el.scrollTop;
	el.dataset.fadeTop = String(el.scrollTop > 1);
	el.dataset.fadeBottom = String(below > 1);
}

function nestedScrollAbsorbsWheel(
	el: { readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number },
	deltaY: number,
) {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	const atTop = el.scrollTop <= 0;
	const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
	return (deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom);
}

/**
 * Keeps the open work scroller pinned to its newest step while live; scrolling up with the wheel
 * pauses auto-follow until the reader scrolls back to the bottom.
 */
function useLivePhaseScroll(el: HTMLDivElement | null, enabled: boolean, steps: readonly Step[]) {
	const stickToBottom = useRef(true);
	const lastScrollTop = useRef(0);
	const wasEnabled = useRef(false);

	const pin = () => {
		if (el === null) return;
		const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 16;
		if (el.scrollTop < lastScrollTop.current - 1 && !nearBottom) {
			stickToBottom.current = false;
		} else if (nearBottom) {
			stickToBottom.current = true;
		}
		if (stickToBottom.current) el.scrollTo({ top: el.scrollHeight });
		lastScrollTop.current = el.scrollTop;
		markScrollEdges(el);
	};

	useLayoutEffect(() => {
		if (!enabled) {
			wasEnabled.current = false;
			return;
		}
		if (!wasEnabled.current) {
			stickToBottom.current = true;
			lastScrollTop.current = el?.scrollTop ?? 0;
			wasEnabled.current = true;
		}
		pin();
	}, [el, enabled, pin, steps]);

	useEffect(() => {
		if (el === null || !enabled) return;
		const onScroll = () => {
			const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 16;
			if (el.scrollTop < lastScrollTop.current - 1 && !nearBottom) {
				stickToBottom.current = false;
			} else if (nearBottom) {
				stickToBottom.current = true;
			}
			lastScrollTop.current = el.scrollTop;
			markScrollEdges(el);
		};
		const onWheel = (event: WheelEvent) => {
			if (!nestedScrollAbsorbsWheel(el, event.deltaY)) return;
			if (event.deltaY < 0) stickToBottom.current = false;
			event.stopPropagation();
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("wheel", onWheel, { passive: true });
		const inner = el.firstElementChild;
		const observer = new ResizeObserver(pin);
		if (inner !== null) observer.observe(inner);
		pin();
		return () => {
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("wheel", onWheel);
			observer.disconnect();
		};
	}, [el, enabled, pin]);
}

/** A part the work log shows, with the reply it is from and where. */
interface Step {
	readonly part: Part;
	readonly reply: HistoryEntry;
	readonly at: number;
}

function WorkLog({
	steps,
	started,
	ended,
	working,
	phase,
	modelName,
}: {
	readonly steps: readonly Step[];
	readonly started: number | undefined;
	/** Absent while the turn is still running. */
	readonly ended: number | undefined;
	/** True while the agent is in its work phase (thinking or running tools before the answer). */
	readonly working: boolean;
	readonly phase: Display;
	readonly modelName: string | undefined;
}) {
	const [override, setOverride] = useState<boolean | null>(null);
	const [liveScroller, setLiveScroller] = useState<HTMLDivElement | null>(null);
	const live = ended === undefined;
	const expandable = steps.length > 0;
	const open = expandable && (override ?? working);
	const [rendered, setRendered] = useState(open);
	if (open && !rendered) setRendered(true);
	useLivePhaseScroll(liveScroller, open, steps);
	const label = <WorkLabel started={started} ended={ended} phase={phase} modelName={modelName} />;
	const icon = (
		<span className="relative flex size-3.5 shrink-0 items-center justify-center">
			<Logo
				className={
					expandable
						? `transition-[opacity,transform] duration-150 ease-out group-hover:scale-90 group-hover:opacity-0 group-focus-visible:scale-90 group-focus-visible:opacity-0 ${
								open ? "scale-90 opacity-0" : ""
							}`
						: ""
				}
			/>
			{expandable && (
				<ChevronRight
					className={`absolute size-3.5 text-ink-muted transition-[opacity,transform] duration-150 ease-out ${
						open
							? "scale-100 rotate-90 opacity-100"
							: "scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100"
					}`}
					strokeWidth={1.75}
					aria-hidden
				/>
			)}
		</span>
	);
	const text = live ? (
		<span className="shimmer-text min-w-0 truncate text-body">{label}</span>
	) : (
		<span
			className={`min-w-0 flex-1 truncate text-body text-ink-muted ${expandable ? "transition-colors duration-150 ease-out group-hover:text-ink" : ""}`}
		>
			{label}
		</span>
	);
	if (!expandable) {
		return (
			<div className="flex w-full min-w-0 items-center gap-1.5 px-4 py-1 text-left">
				{icon}
				{text}
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				aria-label={open ? "Hide the work" : "Show the work"}
				onClick={() => setOverride(!open)}
				className={`group flex w-full min-w-0 items-center gap-1.5 px-4 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
					open ? "zen-fold-drop" : ""
				}`}
			>
				{icon}
				{text}
			</button>
			<div className="zen-phase-body" data-open={open} inert={!open || undefined}>
				{rendered && (
					<div ref={setLiveScroller} className="zen-phase-live">
						<div className="flex min-w-0 flex-col pb-1">
							{steps.map((step, index) => (
								<div
									key={index}
									className={`zen-fold-rail flow-root pr-4 pb-1 pl-9 last:pb-0 ${
										index === steps.length - 1 ? "zen-fold-tail" : ""
									} ${step.part.type === "text" ? "zen-fold-prose" : ""}`}
								>
									<WorkRow {...step} live={working && index === steps.length - 1} />
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

/** First paragraph of a folded block, stripped to one plain line. */
function proseSummary(text: string) {
	const body = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
	const paragraph =
		body
			.split(/\n\s*\n/)
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	return paragraph
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(\*|_)(.+?)\1/g, "$2")
		.replace(/\s+/g, " ")
		.trim();
}

const WorkRow = memo(function WorkRow({ part, reply, at, live = false }: Step & { readonly live?: boolean }) {
	switch (part.type) {
		case "toolCall":
			return <ToolRow call={part} />;
		case "thinking":
			return part.redacted === true || part.thinking === "" ? null : (
				<ThinkingWorkRow reply={reply} at={at} live={live} />
			);
		case "text":
			return <NoteWorkRow text={part.text} />;
		case "image":
			return null;
	}
});

function WorkStepDetail({ open, children }: { readonly open: boolean; readonly children: ReactNode }) {
	const [rendered, setRendered] = useState(open);
	if (open && !rendered) setRendered(true);
	if (!rendered) return null;
	return (
		<div
			inert={!open || undefined}
			className={`grid transition-[grid-template-rows,opacity] duration-180 ease-out ${
				open
					? "grid-rows-[1fr] opacity-100 starting:grid-rows-[0fr] starting:opacity-0"
					: "grid-rows-[0fr] opacity-0"
			}`}
		>
			<div className="min-h-0 min-w-0 overflow-hidden">{children}</div>
		</div>
	);
}

function StepChevron({ open }: { readonly open: boolean }) {
	return (
		<ChevronRight
			className={`size-3.5 shrink-0 text-ink-muted transition-[transform,opacity] duration-150 ease-out ${
				open
					? "rotate-90 opacity-100"
					: "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-visible:opacity-100"
			}`}
			strokeWidth={1.75}
			aria-hidden
		/>
	);
}

function ThinkingWorkRow({
	reply,
	at,
	live = false,
}: {
	readonly reply: HistoryEntry;
	readonly at: number;
	readonly live?: boolean;
}) {
	const text = useStreamed(reply, at);
	const [open, setOpen] = useState(false);
	const summary = proseSummary(text) || "Thinking";
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left outline-none"
			>
				<span
					className={`min-w-0 flex-1 truncate text-body text-ink-muted transition-colors duration-150 ease-out group-hover:text-ink-secondary ${
						live && !open ? "zen-thinking-pulse" : ""
					}`}
				>
					{open ? "Thinking" : summary}
				</span>
				<StepChevron open={open} />
			</button>
			<WorkStepDetail open={open}>
				<div className="min-w-0 pb-2">
					<Markdown text={text} className="agent-reasoning" />
				</div>
			</WorkStepDetail>
		</div>
	);
}

function NoteWorkRow({ text }: { readonly text: string }) {
	const [open, setOpen] = useState(false);
	const summary = proseSummary(text);
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left outline-none"
			>
				<span className="min-w-0 flex-1 truncate text-body text-ink-secondary transition-colors duration-150 ease-out group-hover:text-ink">
					{summary}
				</span>
				<StepChevron open={open} />
			</button>
			<WorkStepDetail open={open}>
				<div className="min-w-0 pb-2">
					<Markdown text={text} />
				</div>
			</WorkStepDetail>
		</div>
	);
}

function ToolRow({ call }: { readonly call: ToolCall }) {
	const [open, setOpen] = useState(false);
	const running = call.status === "pending" || call.status === "running";
	const failed =
		call.status === "error" ||
		call.status === "aborted" ||
		call.status === "skipped" ||
		call.result?.isError === true;
	const output = call.result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const { action, target, chip } = describeTool(call, running);
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left outline-none"
			>
				<span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-code">
					<span className={`shrink-0 font-sans text-body ${failed ? "text-destructive" : "text-ink-muted"}`}>
						{action}
					</span>
					{target !== undefined &&
						(chip ? (
							<span
								title={target}
								className={`max-w-full min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 transition-colors duration-150 ease-out ${
									failed ? "text-destructive" : "text-ink-secondary group-hover:bg-ink/10 group-hover:text-ink"
								}`}
							>
								{target}
							</span>
						) : (
							<span
								title={target}
								className={`min-w-0 flex-1 truncate pl-1 transition-colors duration-150 ease-out ${
									failed ? "text-destructive" : "text-ink-secondary group-hover:text-ink"
								}`}
							>
								{target}
							</span>
						))}
				</span>
				{running ? (
					<CircleDashed
						className="zen-tool-spin size-3.5 shrink-0 text-ink-muted"
						strokeWidth={1.75}
						aria-hidden
					/>
				) : (
					failed && <X className="size-3.5 shrink-0 text-destructive" strokeWidth={2} aria-hidden />
				)}
				<StepChevron open={open} />
			</button>
			<WorkStepDetail open={open}>
				<div className="flex flex-col gap-2 py-1.5 font-mono text-xs">
					<pre className="overflow-x-auto whitespace-pre-wrap text-ink-muted">
						{JSON.stringify(call.arguments, null, 2)}
					</pre>
					{output && (
						<pre
							className={`max-h-64 overflow-auto rounded-lg border border-ink/10 bg-muted px-3 py-2 whitespace-pre-wrap ${
								failed ? "text-destructive" : "text-ink-secondary"
							}`}
						>
							{output}
						</pre>
					)}
				</div>
			</WorkStepDetail>
		</div>
	);
}

function firstString(args: Record<string, unknown>, keys?: readonly string[]): string | undefined {
	if (keys !== undefined) {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value !== "") return value;
		}
	}
	const found = Object.values(args).find((value) => typeof value === "string" && value !== "");
	return typeof found === "string" ? found : undefined;
}

/** Splits a tool call into its action verb and target chip, as in the activity trail. */
function describeTool(
	call: ToolCall,
	running: boolean,
): { readonly action: string; readonly target: string | undefined; readonly chip: boolean } {
	switch (call.name) {
		case "bash":
		case "shell":
		case "exec":
			return {
				action: running ? "Running" : "Ran",
				target: firstString(call.arguments, ["command", "cmd"]),
				chip: true,
			};
		case "read":
			return { action: "Read", target: firstString(call.arguments, ["path", "file", "filePath"]), chip: true };
		case "write":
			return { action: "Write", target: firstString(call.arguments, ["path", "file", "filePath"]), chip: true };
		case "edit":
		case "multiedit":
		case "patch":
			return { action: "Edit", target: firstString(call.arguments, ["path", "file", "filePath"]), chip: true };
		case "ls":
		case "list":
			return { action: "List", target: firstString(call.arguments, ["path", "dir", "directory"]), chip: true };
		case "grep":
		case "glob":
		case "find":
		case "search":
		case "toolsearch":
			return {
				action: "Find",
				target: firstString(call.arguments, ["pattern", "query", "glob", "path"]),
				chip: false,
			};
		default:
			return { action: call.name, target: firstString(call.arguments), chip: false };
	}
}
