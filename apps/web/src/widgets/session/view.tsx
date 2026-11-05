import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { type HistoryEntry, Part, type QueuedPrompt, type ToolCall } from "@codeworksh/widget/codework";
import { useBus, useEvents, useFrame, type WidgetProps } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { ChevronRight, CircleDashed, X } from "lucide-react";
import { createContext, memo, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Logo } from "@/components/logo";
import { ComposerNotice, type Notice } from "@/components/banner";
import { Monogram } from "@/components/monogram";
import { useModelName, useModelsNotice } from "@/components/model";
import { threadRef } from "./address";
import { SessionComposer } from "./composer";
import { Markdown } from "./markdown";
import { Message } from "./message";
import { Queue } from "./queue";
import { type Handoff, handoffs } from "./handoff";
import { projectsAtom, useListedSession } from "./projects";
import { type Info, Json, type ThreadRef, threadKey, topics, type Update } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeWindow = Schema.decodeUnknownOption(Json.Window);
const decodeUpdate = Schema.decodeUnknownOption(Json.Update);
const samePart = Schema.toEquivalence(Part);

/** Messages per page: the newest on open, then older ones as the reader scrolls up. */
const PAGE = 60;

// Shared reading width for the transcript and floating composer.
const contentWidth = "mx-auto w-full max-w-conversation";

export function Session({ address, instanceId }: WidgetProps<unknown>) {
	const thread = useMemo(() => threadRef(address), [address]);
	const key = thread === undefined ? (address ?? "") : threadKey(thread);
	// The thread this frame showed before, so a switch can keep it in view while the next one loads.
	const [shown, setShown] = useState<{ readonly key: string; readonly previous?: string }>({ key });
	if (shown.key !== key) setShown({ key, previous: shown.key });
	if (thread === undefined) return <p className="p-3 text-ink-muted">Not a session: {address}</p>;
	return <Conversation key={key} thread={thread} instanceId={instanceId} previous={shown.previous} />;
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
			/** Whether the agent works, once the backend has said; until then a draft reply implies it. */
			readonly running: boolean | undefined;
			/** Why the last run failed, until another one starts. */
			readonly failure?: Notice;
	  };

type Ready = Extract<State, { readonly status: "ready" }>;

const isRunning = (state: Ready) => {
	const last = state.messages.at(-1);
	return state.running ?? (last?.role === "assistant" && last.state === "draft");
};

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
const noticeOf = (kind: string, message: string, sandbox: string | undefined): Notice => {
	switch (kind) {
		// The session's sandbox is gone, so it can't run; its conversation is still saved and readable.
		// A memory one lives only as long as the server that made it.
		case "sandbox-mount-error":
			return {
				title: "Expired",
				description:
					sandbox === "memory"
						? "Memory sessions can’t continue after closed. Start a new session to keep going."
						: "This session can't be picked up again. Start a new session to keep going.",
				tone: "expired",
			};
		default:
			return { title: "Something went wrong", description: message, tone: "error" };
	}
};

const apply = (state: State, update: Update): State => {
	if (state.status !== "ready") return state;
	switch (update._tag) {
		case "Info":
			return { ...state, info: update.info };
		case "Queue":
			return { ...state, queued: update.queued };
		case "Removed":
			return { ...state, messages: state.messages.filter((message) => message.id !== update.id) };
		case "Running": {
			const { failure: _, ...rest } = state;
			return update.running ? { ...rest, running: true } : { ...state, running: false };
		}
		case "Failed":
			return { ...state, failure: noticeOf(update.kind, update.message, state.info.sandbox) };
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
			const message =
				previous === undefined
					? update.message
					: {
							...update.message,
							parts: update.message.parts.map((part, at) => {
								const old = previous.parts[at];
								return old !== undefined && samePart(old, part) ? old : part;
							}),
						};
			return {
				...state,
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
		previous.running === next.running &&
		previous.failure === next.failure &&
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
	const select = useCallback(
		(entry: HistoryEntry | undefined) => (entry === undefined ? undefined : textOf(entry, at)),
		[at],
	);
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

	const page = useCallback(
		async (before: string | undefined) => {
			const reply = decodeWindow(
				(
					await bus.request({
						topic: topics.page,
						payload: { ...thread, limit: PAGE, ...(before === undefined ? {} : { before }) },
					})
				).payload,
			);
			return Option.getOrUndefined(reply);
		},
		[bus, thread],
	);

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
			if (active) setState({ status: "ready", info, messages, more, queued, after: seq, running: undefined });
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

	const oldest = state.status === "ready" && state.more ? state.messages[0]?.id : undefined;
	const loadOlder = useCallback(
		(beforePrepend: () => void) => {
			if (oldest === undefined || paging.current) return;
			paging.current = true;
			void page(oldest)
				.then((window) => {
					if (window?._tag !== "Window") return;
					beforePrepend();
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
		},
		[oldest, page],
	);

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
	const outcome = `${run?.running}|${run?.failure?.title ?? ""}|${run?.failure?.description ?? ""}`;
	const [seenOutcome, setSeenOutcome] = useState(outcome);
	if (outcome !== seenOutcome) {
		setSeenOutcome(outcome);
		if (sent.length > 0 && (run?.running === false || run?.failure !== undefined)) setSent([]);
	}
	const state = useMemo<State>(() => {
		if (loaded.status !== "ready" || sent.length === 0) return loaded;
		const ids = new Set(sent.map((message) => message.id));
		return {
			...loaded,
			// A prompt not yet taken in is about to wake the agent: busy until the server says otherwise.
			running: loaded.running ?? true,
			messages: [...loaded.messages, ...sent],
			queued: loaded.queued.some((prompt) => ids.has(prompt.id))
				? loaded.queued.filter((prompt) => !ids.has(prompt.id))
				: loaded.queued,
		};
	}, [loaded, sent]);
	const sending = useCallback(
		(prompt: Handoff) => setSent((current) => [...current, standIn(thread, prompt)]),
		[thread],
	);
	const unsent = useCallback((id: string) => setSent((current) => current.filter((message) => message.id !== id)), []);
	// Named from the sessions list at once, so the frame never shows its default title while loading.
	const listed = useListedSession(thread.sessionId);
	const title = state.status === "ready" ? state.info.title : listed?.title;
	// A first prompt names the session after the list was fetched; the main thread's title is the listed one.
	const refreshProjects = useAtomRefresh(projectsAtom);
	const stale = thread.threadId === undefined && state.status === "ready" && listed?.title !== title;
	useEffect(() => {
		if (stale) refreshProjects();
	}, [stale, title, refreshProjects]);
	const project = state.status === "ready" ? state.info.project : listed?.project;
	const projectId = project?.id;
	const projectName = project?.name;

	useEffect(() => {
		if (title === undefined) return;
		// The project leads, so sessions from different projects tell apart at a glance.
		setTitle(title, projectName);
		// The project's badge, as in the sessions sidebar.
		if (projectId !== undefined && projectName !== undefined) setIcon(<Monogram id={projectId} name={projectName} />);
		// While focused, the workspace's tab reads as this session: its project, then its title.
		setTab(projectName === undefined ? title : `${projectName} / ${title}`);
	}, [title, projectId, projectName, setTitle, setIcon, setTab]);

	// Models that can't be listed first: a state that clears itself, so it can't be dismissed. Then a
	// refused send, else why the last run failed; dismissing hides that one notice only.
	const models = useModelsNotice(state.status === "ready" ? state.info.hostDir : undefined);
	const [sendError, setSendError] = useState<string>();
	// A queued prompt taken back to edit; the composer puts its text above the draft.
	const [restored, setRestored] = useState<{ readonly text: string; readonly key: number }>();
	const restore = useCallback(
		(text: string) => setRestored((current) => ({ text, key: (current?.key ?? 0) + 1 })),
		[],
	);
	const [dismissed, setDismissed] = useState<Notice>();
	const notice: Notice | undefined =
		sendError !== undefined
			? { title: "Not sent", description: sendError, tone: "error" }
			: state.status === "ready"
				? state.failure
				: undefined;
	const shown =
		notice !== undefined && (dismissed?.title !== notice.title || dismissed.description !== notice.description);

	const surface = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLDivElement>(null);
	// Before paint, so the first frame is laid out with both heights.
	useLayoutEffect(() => {
		const root = surface.current;
		const element = composer.current;
		if (root === null || element === null) return;
		const sync = () => {
			root.style.setProperty("--transcript-height", `${root.getBoundingClientRect().height}px`);
			root.style.setProperty("--composer-height", `${element.getBoundingClientRect().height}px`);
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(root);
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
				<Transcript
					key={stand === undefined ? "own" : "stand"}
					state={view}
					running={running}
					loadOlder={loadOlder}
				/>
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
						onError={setSendError}
						onRestore={restore}
					/>
				)}
				<SessionComposer
					thread={thread}
					instanceId={instanceId}
					running={running}
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
			{slow && "Loading messages…"}
		</div>
	);
}

const turnKey = (turn: Turn) => turn.user?.id ?? turn.replies[0]?.id ?? "empty";

const PROMPT_JUST_SENT_MS = 1500;
const PROMPT_RISE_MS = 560;
const PROMPT_REVEAL_MS = 320;
const PROMPT_FADE_MS = 480;
const PROMPT_RISE_FROM = 0.3;

/**
 * Keeps the live turn's min-height equal to the visible transcript height above the composer, so
 * pinning to the bottom places the latest user prompt at the very top of the viewport.
 */
function syncTranscriptViewport(el: HTMLElement | null) {
	if (el === null || el.clientHeight <= 0) return;
	const inner = el.querySelector<HTMLElement>("[data-transcript-content]");
	const style = inner !== null ? getComputedStyle(inner) : null;
	const pad =
		style !== null ? (Number.parseFloat(style.paddingBottom) || 0) + (Number.parseFloat(style.paddingTop) || 0) : 0;
	el.style.setProperty("--transcript-viewport", `${Math.max(0, el.clientHeight - pad)}px`);
}

/** Fades a freshly sent prompt in while sliding it from the upper viewport into its top anchor. */
function riseIntoAnchor(scroller: HTMLElement | null, promptId: string) {
	if (scroller === null) return undefined;
	const row = scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(promptId)}"]`);
	if (row === null || typeof row.animate !== "function") return undefined;
	if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
	const view = scroller.getBoundingClientRect();
	const dy = view.top + view.height * PROMPT_RISE_FROM - row.getBoundingClientRect().top;
	if (dy <= 1) return undefined;
	const animation = row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
		duration: PROMPT_RISE_MS,
		easing: "cubic-bezier(0.22, 1, 0.36, 1)",
	});
	const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], {
		duration: PROMPT_FADE_MS,
		easing: "ease-out",
	});
	const turn = row.closest<HTMLElement>(".transcript-turn");
	let revealTimer: ReturnType<typeof setTimeout> | undefined;
	turn?.setAttribute("data-prompt-rise", "rising");
	animation.onfinish = () => {
		turn?.setAttribute("data-prompt-rise", "revealing");
		revealTimer = setTimeout(() => turn?.removeAttribute("data-prompt-rise"), PROMPT_REVEAL_MS);
	};
	return () => {
		animation.cancel();
		fade.cancel();
		clearTimeout(revealTimer);
		turn?.removeAttribute("data-prompt-rise");
	};
}

/**
 * The conversation as a list of turns. Sending a prompt anchors the new turn to the top of the
 * viewport (`.transcript-turn-anchor`) so older turns scroll above the screen unless the reader
 * scrolls up.
 */
function Transcript({
	state,
	running,
	loadOlder,
}: {
	readonly state: Ready;
	readonly running: boolean;
	readonly loadOlder: (beforePrepend: () => void) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const lastScrollTop = useRef(0);
	const touchY = useRef<number | undefined>(undefined);
	const prependHeight = useRef<number | null>(null);
	const [scrolled, setScrolled] = useState(false);
	const modelName = useModelName(state.info.hostDir, state.info.model);
	const turns = useMemo(() => turnsOf(state.messages), [state.messages]);
	const lastUser = turns.at(-1)?.user;
	const lastUserId = lastUser?.id;
	const [anchorTurn, setAnchorTurn] = useState(
		() => running || (lastUser !== undefined && Date.now() - lastUser.createdAt < 5000),
	);
	const seenUserId = useRef(lastUserId);
	if (lastUserId !== seenUserId.current) {
		seenUserId.current = lastUserId;
		if (lastUserId !== undefined && !anchorTurn) setAnchorTurn(true);
	}

	const pinToBottom = useCallback((el: HTMLElement | null) => {
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
		lastScrollTop.current = el.scrollTop;
		setScrolled(el.scrollTop > 1);
	}, []);

	useLayoutEffect(() => {
		stickToBottom.current = true;
		const el = scroller.current;
		syncTranscriptViewport(el);
		pinToBottom(el);
	}, [lastUserId, anchorTurn, pinToBottom]);

	const introducedPrompt = useRef<{ id: string | undefined; cancel: (() => void) | undefined }>(undefined);
	useLayoutEffect(() => {
		const previous = introducedPrompt.current;
		if (previous !== undefined && previous.id === lastUserId) return;
		const mounting = previous === undefined;
		previous?.cancel?.();
		const current: { id: string | undefined; cancel: (() => void) | undefined } = {
			id: lastUserId,
			cancel: undefined,
		};
		introducedPrompt.current = current;
		if (lastUserId === undefined || !anchorTurn) return;
		if (
			mounting &&
			!(
				running &&
				turns.length === 1 &&
				lastUser !== undefined &&
				Date.now() - lastUser.createdAt < PROMPT_JUST_SENT_MS
			)
		)
			return;
		current.cancel = riseIntoAnchor(scroller.current, lastUserId);
	}, [lastUserId, anchorTurn, running, turns.length, lastUser]);

	const firstTurnKey = turns[0] !== undefined ? turnKey(turns[0]) : undefined;
	const seenFirstTurnKey = useRef(firstTurnKey);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el === null) return;
		if (seenFirstTurnKey.current !== firstTurnKey && prependHeight.current !== null) {
			const delta = el.scrollHeight - prependHeight.current;
			prependHeight.current = null;
			seenFirstTurnKey.current = firstTurnKey;
			if (delta > 0) {
				el.scrollTop += delta;
				lastScrollTop.current = el.scrollTop;
			}
			return;
		}
		seenFirstTurnKey.current = firstTurnKey;
		prependHeight.current = null;
		// Growth is pinned by the resize observer below, once per layout rather than once per update.
	}, [turns, firstTurnKey]);

	useLayoutEffect(() => {
		const el = scroller.current;
		const inner = el?.firstElementChild;
		if (el === null || inner === null || inner === undefined) return;
		// Runs after layout and before paint. The viewport is measured again only when the scroller
		// itself resizes; content growing only needs pinning.
		const observer = new ResizeObserver((entries) => {
			if (!el.isConnected) return;
			if (entries.some((entry) => entry.target === el)) syncTranscriptViewport(el);
			if (stickToBottom.current) pinToBottom(el);
		});
		observer.observe(el);
		observer.observe(inner);
		syncTranscriptViewport(el);
		if (stickToBottom.current) pinToBottom(el);
		return () => observer.disconnect();
	}, [pinToBottom, turns.length]);

	if (turns.length === 0)
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-3">
				<p className="text-center text-body text-ink-muted">Send a message to start the conversation.</p>
			</div>
		);
	return (
		<div
			ref={scroller}
			tabIndex={0}
			aria-label="Conversation"
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
					stickToBottom.current = false;
				}
			}}
			onTouchStart={(event) => {
				touchY.current = event.touches[0]?.clientY;
			}}
			onTouchMove={(event) => {
				const next = event.touches[0]?.clientY;
				if (next !== undefined && touchY.current !== undefined && next > touchY.current) {
					stickToBottom.current = false;
				}
				touchY.current = next;
			}}
			onWheel={(event) => {
				if (event.deltaY < 0) stickToBottom.current = false;
			}}
			onScroll={(event) => {
				const el = event.currentTarget;
				const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 16;
				if (el.scrollTop < lastScrollTop.current - 1 && !nearBottom) {
					stickToBottom.current = false;
				} else if (nearBottom && el.scrollTop > lastScrollTop.current) {
					stickToBottom.current = true;
				}
				lastScrollTop.current = el.scrollTop;
				setScrolled(el.scrollTop > 1);
				if (state.more && el.scrollTop < 120 && prependHeight.current === null) {
					// Capture just before insertion: streamed updates may arrive while the page loads.
					loadOlder(() => {
						prependHeight.current = el.scrollHeight;
					});
				}
			}}
			className={`session-transcript min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none] ${scrolled ? "session-transcript-scrolled" : ""}`}
		>
			<div
				data-transcript-content=""
				className="flex min-w-0 flex-col gap-1 pt-5 pb-[calc(var(--composer-height,60px)+24px)]"
			>
				{turns.map((item, index) => {
					const last = index === turns.length - 1;
					return (
						<TurnView
							key={turnKey(item)}
							turn={item}
							active={running && last}
							anchored={anchorTurn && last && item.user !== undefined}
							modelName={modelName}
						/>
					);
				})}
			</div>
		</div>
	);
}

/** A user message and the agent's replies to it, up to the next user message. */
interface Turn {
	readonly user: HistoryEntry | undefined;
	readonly replies: readonly HistoryEntry[];
}

function turnsOf(entries: readonly HistoryEntry[]): Turn[] {
	const turns: { user: HistoryEntry | undefined; replies: HistoryEntry[] }[] = [];
	for (const entry of entries) {
		const current = turns.at(-1);
		if (entry.role === "user" || current === undefined) turns.push({ user: undefined, replies: [] });
		const turn = turns.at(-1)!;
		if (entry.role === "user") turn.user = entry;
		else turn.replies.push(entry);
	}
	return turns;
}

// Turns are rebuilt on every structural update, but their messages are the same objects unless they changed.
const sameTurn = (
	a: {
		readonly turn: Turn;
		readonly active: boolean;
		readonly anchored: boolean;
		readonly modelName: string | undefined;
	},
	b: {
		readonly turn: Turn;
		readonly active: boolean;
		readonly anchored: boolean;
		readonly modelName: string | undefined;
	},
) =>
	a.active === b.active &&
	a.anchored === b.anchored &&
	a.modelName === b.modelName &&
	a.turn.user === b.turn.user &&
	a.turn.replies.length === b.turn.replies.length &&
	a.turn.replies.every((reply, index) => reply === b.turn.replies[index]);

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
const TurnView = memo(function TurnView({
	turn,
	active,
	anchored,
	modelName,
}: {
	readonly turn: Turn;
	readonly active: boolean;
	readonly anchored: boolean;
	readonly modelName: string | undefined;
}) {
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
	const ended = active ? undefined : endOf(turn.replies);

	return (
		<section
			className={`transcript-turn ${contentWidth} flex flex-col pt-2 pb-1 text-body ${anchored ? "transcript-turn-anchor" : ""}`}
		>
			{turn.user !== undefined && <UserMessage entry={turn.user} />}
			{(work.length > 0 || working || answer || interrupted || failed) && (
				<Message
					role="assistant"
					at={turn.replies[0]?.createdAt}
					ended={ended}
					copyText={last === undefined ? "" : textOf(last)}
				>
					<WorkLog steps={work} started={started} ended={ended} working={working} modelName={modelName} />
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

function UserMessage({ entry }: { readonly entry: HistoryEntry }) {
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
		<Message role="user" promptId={entry.id} at={entry.createdAt} copyText={text}>
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
					className="mt-1 rounded-sm px-1 py-0.5 text-xs text-message-ink/65 hover:bg-message-ink/10 hover:text-message-ink"
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

function useElapsedFrom(startedAt: number | undefined, active: boolean): number | undefined {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active || startedAt === undefined) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [startedAt, active]);
	return active && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined;
}

// A leaf of its own, so the live tick re-renders only the label's text.
function WorkLabel({
	started,
	ended,
	modelName,
}: {
	readonly started: number | undefined;
	readonly ended: number | undefined;
	readonly modelName: string | undefined;
}) {
	const live = ended === undefined;
	const liveElapsed = useElapsedFrom(started, live);
	const elapsedMs = live ? liveElapsed : started !== undefined && ended >= started ? ended - started : undefined;
	return formatWorkingDuration(elapsedMs, modelName, !live);
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

	const pin = useCallback(() => {
		if (el === null) return;
		const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 16;
		if (el.scrollTop < lastScrollTop.current - 1 && !nearBottom) {
			stickToBottom.current = false;
		} else if (nearBottom) {
			stickToBottom.current = true;
		}
		if (stickToBottom.current) el.scrollTop = el.scrollHeight;
		lastScrollTop.current = el.scrollTop;
		markScrollEdges(el);
	}, [el]);

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
	modelName,
}: {
	readonly steps: readonly Step[];
	readonly started: number | undefined;
	/** Absent while the turn is still running. */
	readonly ended: number | undefined;
	/** True while the agent is in its work phase (thinking or running tools before the answer). */
	readonly working: boolean;
	readonly modelName: string | undefined;
}) {
	const [override, setOverride] = useState<boolean | null>(null);
	const [liveScroller, setLiveScroller] = useState<HTMLDivElement | null>(null);
	const live = ended === undefined;
	const expandable = steps.length > 0;
	const open = expandable && (override ?? working);
	useLivePhaseScroll(liveScroller, open, steps);
	const label = <WorkLabel started={started} ended={ended} modelName={modelName} />;
	const icon = (
		<span className="relative flex size-3.5 shrink-0 items-center justify-center">
			{open && expandable ? (
				<ChevronRight className="size-3.5 rotate-90 text-ink-muted" strokeWidth={1.75} aria-hidden />
			) : (
				<>
					<Logo
						className={
							expandable
								? "transition-opacity duration-150 ease-out group-hover:opacity-0 group-focus-visible:opacity-0"
								: ""
						}
					/>
					{expandable && (
						<ChevronRight
							className="absolute size-3.5 text-ink-muted opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
							strokeWidth={1.75}
							aria-hidden
						/>
					)}
				</>
			)}
		</span>
	);
	const text = live ? (
		<span className="shimmer-text min-w-0 truncate text-body">{label}</span>
	) : (
		<span
			className={`min-w-0 flex-1 truncate text-body text-ink-muted ${expandable ? "transition-colors duration-200 group-hover:text-ink" : ""}`}
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
			<div className="zen-phase-body" data-open={open}>
				{open && (
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
	const summary = useMemo(() => proseSummary(text) || "Thinking", [text]);
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex min-w-0 items-center gap-1.5 py-1 text-left outline-none"
			>
				<span
					className={`min-w-0 flex-1 truncate text-body text-ink-muted transition-colors duration-200 group-hover:text-ink-secondary ${
						live && !open ? "zen-thinking-pulse" : ""
					}`}
				>
					{open ? "Thinking" : summary}
				</span>
			</button>
			{open && (
				<div className="min-w-0 pb-2">
					<Markdown text={text} className="agent-reasoning" />
				</div>
			)}
		</div>
	);
}

function NoteWorkRow({ text }: { readonly text: string }) {
	const [open, setOpen] = useState(false);
	const summary = useMemo(() => proseSummary(text), [text]);
	return (
		<div className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex min-w-0 items-center gap-1.5 py-1 text-left outline-none"
			>
				<span className="min-w-0 flex-1 truncate text-body text-ink-secondary transition-colors duration-200 group-hover:text-ink">
					{summary}
				</span>
			</button>
			{open && (
				<div className="min-w-0 pb-2">
					<Markdown text={text} />
				</div>
			)}
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
								className={`max-w-full min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 ${
									failed ? "text-destructive" : "text-ink-secondary group-hover:bg-ink/10 group-hover:text-ink"
								}`}
							>
								{target}
							</span>
						) : (
							<span
								title={target}
								className={`min-w-0 flex-1 truncate pl-1 ${
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
				<ChevronRight
					className={`size-3.5 shrink-0 text-ink-muted transition-transform ${
						open ? "rotate-90" : "opacity-0 group-hover:opacity-100"
					}`}
					strokeWidth={1.75}
					aria-hidden
				/>
			</button>
			{open && (
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
			)}
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
