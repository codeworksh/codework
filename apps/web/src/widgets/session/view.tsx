import { LegendList, type MaintainScrollAtEndOptions } from "@legendapp/list/react";
import type { HistoryEntry, Part, QueuedPrompt, ToolCall } from "@codeworksh/widget/codework";
import { useBus, useEvents, useFrame, type WidgetProps } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { Brain, ChevronDown, ChevronRight, CircleAlert, Terminal, Wrench } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ComposerNotice, type Notice } from "@/components/banner";
import { Monogram } from "@/components/monogram";
import { useModelsNotice } from "@/components/model";
import { sessionId } from "./address";
import { SessionComposer } from "./composer";
import { Markdown } from "./markdown";
import { Message } from "./message";
import { Queue } from "./queue";
import { useListedSession } from "./projects";
import { type Info, Json, topics, type Update } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeWindow = Schema.decodeUnknownOption(Json.Window);
const decodeUpdate = Schema.decodeUnknownOption(Json.Update);

/** Messages per page: the newest on open, then older ones as the reader scrolls up. */
const PAGE = 60;

// Shared reading width for the transcript and floating composer.
const contentWidth = "mx-auto w-full max-w-[62rem]";

export function Session({ address, instanceId }: WidgetProps<unknown>) {
	const id = sessionId(address);
	if (id === undefined) return <p className="p-3 text-ink-muted">Not a session: {address}</p>;
	return <Conversation key={id} id={id} instanceId={instanceId} />;
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
			const index = state.messages.findIndex((message) => message.id === update.message.id);
			const oldest = state.messages[0];
			// A message older than the window has not been paged in; its page will carry it.
			if (index === -1 && state.more && oldest !== undefined && update.message.seq < oldest.seq) return state;
			// A streamed draft can land just after the reply it belongs to ended; an ended reply stays ended.
			if (index !== -1 && update.message.state === "draft" && state.messages[index]?.state !== "draft") return state;
			return {
				...state,
				messages: index === -1 ? [...state.messages, update.message] : state.messages.with(index, update.message),
				// Promoted: it is in the conversation now, whatever the next queue update says.
				queued: state.queued.filter((prompt) => prompt.id !== update.message.id),
			};
		}
	}
};

/**
 * Asks the session backend to follow the session, loads its newest page, then applies every update
 * published after that page. Older pages load on demand. A dropped connection resumes where it
 * left off.
 */
function useConversation(id: string) {
	const bus = useBus();
	const [state, setState] = useState<State>({ status: "loading" });
	const paging = useRef(false);

	const page = useCallback(
		async (before: string | undefined) => {
			const reply = decodeWindow(
				(
					await bus.request({
						topic: topics.page,
						payload: { sessionId: id, limit: PAGE, ...(before === undefined ? {} : { before }) },
					})
				).payload,
			);
			return Option.getOrUndefined(reply);
		},
		[bus, id],
	);

	useEffect(() => {
		let active = true;
		const fail = (message: string) => {
			if (active) setState({ status: "failed", message });
		};
		void (async () => {
			const reply = decodeReply((await bus.request({ topic: topics.follow, payload: { sessionId: id } })).payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") return fail(reply.value.message);
			const window = await page(undefined);
			if (window === undefined) return fail(`Could not load session ${id}.`);
			if (window._tag === "Failed") return fail(window.message);
			const { info, messages, more, queued, seq } = window;
			if (active) setState({ status: "ready", info, messages, more, queued, after: seq, running: undefined });
		})().catch(() => fail("The CodeWork server is not reachable."));
		return () => {
			active = false;
		};
	}, [bus, id, page]);

	const after = state.status === "ready" ? state.after : undefined;
	useEvents(after === undefined ? undefined : { topics: [topics.session(id)], after }, (item) => {
		if ("_tag" in item) return;
		const update = decodeUpdate(item.payload);
		if (Option.isSome(update)) setState((current) => apply(current, update.value));
	});

	const oldest = state.status === "ready" && state.more ? state.messages[0]?.id : undefined;
	const loadOlder = useCallback(() => {
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
	}, [oldest, page]);

	return { state, loadOlder };
}

function Conversation({ id, instanceId }: { readonly id: string; readonly instanceId: string }) {
	const { setTitle, setIcon, setTab } = useFrame();
	const { state, loadOlder } = useConversation(id);
	// Named from the sessions list at once, so the frame never shows its default title while loading.
	const listed = useListedSession(id);
	const title = state.status === "ready" ? state.info.title : listed?.title;
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
	useEffect(() => {
		const element = composer.current;
		if (element === null) return;
		const observer = new ResizeObserver(() => {
			surface.current?.style.setProperty("--composer-height", `${element.getBoundingClientRect().height}px`);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [state.status]);

	if (state.status === "loading") return null;
	if (state.status === "failed") return <p className="p-3 text-ink-muted">{state.message}</p>;
	const last = state.messages.at(-1);
	const running = state.running ?? (last?.role === "assistant" && last.state === "draft");
	return (
		<div ref={surface} className="relative flex h-full flex-col">
			<Transcript state={state} running={running} loadOlder={loadOlder} />
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
				{state.queued.length > 0 && (
					<Queue
						sessionId={id}
						queued={state.queued}
						running={running}
						onError={setSendError}
						onRestore={(text) => setRestored((current) => ({ text, key: (current?.key ?? 0) + 1 }))}
					/>
				)}
				<SessionComposer
					sessionId={id}
					instanceId={instanceId}
					running={running}
					info={state.info}
					onError={setSendError}
					restored={restored}
				/>
			</div>
		</div>
	);
}

// New turns, growing replies and a taller composer (queued prompts above it) keep the list at its
// end while the reader is there; a reader scrolled up stays where they are.
const follow = {
	animated: false,
	on: { dataChange: true, footerLayout: true, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;

// Prepending an older page, or a row growing above the viewport, keeps what the reader sees in place.
const anchor = { data: true, size: true } as const;

const turnKey = (turn: Turn) => turn.user?.id ?? turn.replies[0]?.id ?? "empty";

/**
 * The conversation as a virtualized list of turns: only those near the viewport are mounted, and an
 * update re-renders only the turn whose messages changed.
 */
function Transcript({
	state,
	running,
	loadOlder,
}: {
	readonly state: Ready;
	readonly running: boolean;
	readonly loadOlder: () => void;
}) {
	const [scrolled, setScrolled] = useState(false);
	const turns = useMemo(() => turnsOf(state.messages), [state.messages]);
	const renderItem = useCallback(
		({ item, index }: { readonly item: Turn; readonly index: number }) => (
			<TurnView turn={item} active={running && index === turns.length - 1} />
		),
		[running, turns.length],
	);
	if (turns.length === 0)
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-3">
				<p className="text-center text-sm text-ink-muted/40">Send a message to start the conversation.</p>
			</div>
		);
	return (
		<LegendList<Turn>
			data={turns}
			keyExtractor={turnKey}
			renderItem={renderItem}
			extraData={running}
			estimatedItemSize={160}
			// Turns hold their own state (an open work log), so a reused row must not carry it over.
			recycleItems={false}
			initialScrollAtEnd
			maintainScrollAtEnd={follow}
			maintainVisibleContentPosition={anchor}
			onStartReached={state.more ? loadOlder : undefined}
			ListFooterComponent={<div className="h-[calc(var(--composer-height,60px)+24px)]" />}
			onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 1)}
			className={`session-transcript min-h-0 flex-1 overflow-x-hidden overscroll-y-contain [overflow-anchor:none] ${scrolled ? "session-transcript-scrolled" : ""}`}
		/>
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

// Turns are rebuilt on every update, but their messages are the same objects unless they changed.
const sameTurn = (
	a: { readonly turn: Turn; readonly active: boolean },
	b: { readonly turn: Turn; readonly active: boolean },
) =>
	a.active === b.active &&
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
const TurnView = memo(function TurnView({ turn, active }: { readonly turn: Turn; readonly active: boolean }) {
	const last = turn.replies.at(-1);
	const answer = last?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) ?? [];
	const work = turn.replies
		.flatMap((reply) => reply.parts.filter((part) => !(reply === last && part.type === "text")))
		.filter(isWork);
	const interrupted = last?.state === "aborted";
	// While the agent works and no answer is streaming, it is thinking or running a tool.
	const thinking = active && (last?.state !== "draft" || answer.length === 0);

	return (
		<section className={`${contentWidth} flex flex-col gap-5 px-4 py-3 text-sm leading-relaxed`}>
			{turn.user !== undefined && <UserMessage entry={turn.user} />}
			{(work.length > 0 || thinking || answer.length > 0 || interrupted) && (
				<Message role="assistant" at={turn.replies[0]?.createdAt}>
					{work.length > 0 && (
						<WorkLog
							parts={work}
							started={turn.user?.createdAt}
							ended={active ? undefined : endOf(turn.replies)}
						/>
					)}
					{thinking && <ThinkingRow />}
					{answer.length > 0 && (
						<div>
							<Markdown text={answer.join("\n\n")} streaming={last?.state === "draft"} />
						</div>
					)}
					{interrupted && <p className="text-xs text-ink-muted">Interrupted</p>}
				</Message>
			)}
		</section>
	);
}, sameTurn);

/** The agent at work with nothing to show yet; static, so it costs no repaints while it waits. */
function ThinkingRow() {
	return (
		<div className="flex min-h-6 items-center gap-1.5 px-0.5 text-ink-muted">
			<span className="grid size-6 shrink-0 place-items-center">
				<Brain className="size-3.5" strokeWidth={1.75} aria-hidden />
			</span>
			Thinking
		</div>
	);
}

function UserMessage({ entry }: { readonly entry: HistoryEntry }) {
	const text = entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
	const images = entry.parts.filter((part) => part.type === "image").length;
	return (
		<Message role="user" at={entry.createdAt}>
			{text !== "" && <p className="whitespace-pre-wrap">{text}</p>}
			{images > 0 && <p className="text-xs text-ink-muted">{images === 1 ? "1 image" : `${images} images`}</p>}
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

const duration = (ms: number) => {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

function WorkLog({
	parts,
	started,
	ended,
}: {
	readonly parts: readonly Part[];
	readonly started: number | undefined;
	/** Absent while the turn is still running. */
	readonly ended: number | undefined;
}) {
	const [open, setOpen] = useState(false);
	const label =
		ended === undefined
			? "Working"
			: started !== undefined && ended > started
				? `Worked for ${duration(ended - started)}`
				: "Worked";
	return (
		<div>
			<div className="flex items-center gap-2 border-b border-edge/50 pb-2 text-xs text-ink-muted">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className="-mx-1 flex items-center gap-1 rounded-md px-1 text-ink-muted transition-colors outline-none hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-ring"
				>
					{label}
					{open ? (
						<ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
					) : (
						<ChevronRight className="size-3.5 text-ink-muted" aria-hidden />
					)}
				</button>
			</div>
			{open && (
				<div className="flex flex-col pt-1.5">
					{parts.map((part, index) => (
						<WorkRow key={index} part={part} />
					))}
				</div>
			)}
		</div>
	);
}

function WorkRow({ part }: { readonly part: Part }) {
	switch (part.type) {
		case "toolCall":
			return <ToolRow call={part} />;
		case "thinking":
			return part.redacted === true || part.thinking === "" ? null : (
				<Row icon={<Brain className="size-3.5" strokeWidth={1.75} />} label="Thought">
					<p className="whitespace-pre-wrap text-ink-muted">{part.thinking}</p>
				</Row>
			);
		case "text":
			return (
				<div className="py-1 text-ink-muted">
					<Markdown text={part.text} />
				</div>
			);
		case "image":
			return null;
	}
}

function ToolRow({ call }: { readonly call: ToolCall }) {
	const failed = call.status === "error" || call.status === "aborted" || call.status === "skipped";
	const output = call.result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const icon = failed ? (
		<CircleAlert className="size-3.5 text-destructive" strokeWidth={1.75} />
	) : call.name === "bash" ? (
		<Terminal className="size-3.5" strokeWidth={1.75} />
	) : (
		<Wrench className="size-3.5" strokeWidth={1.75} />
	);
	return (
		<Row icon={icon} label={summarize(call)}>
			<div className="flex flex-col gap-2 font-mono text-xs">
				<pre className="overflow-x-auto whitespace-pre-wrap text-ink-muted">
					{JSON.stringify(call.arguments, null, 2)}
				</pre>
				{output && (
					<pre className="max-h-64 overflow-auto rounded-lg border border-edge bg-desktop/60 px-3 py-2 whitespace-pre-wrap">
						{output}
					</pre>
				)}
			</div>
		</Row>
	);
}

/** A compact work-log line: icon and one-line label; clicking it shows the details beneath. */
function Row({
	icon,
	label,
	children,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="group flex min-h-6 w-full items-center gap-1.5 rounded-md px-0.5 text-left transition-colors hover:bg-ink/5"
			>
				<span className="grid size-6 shrink-0 place-items-center text-ink-muted">{icon}</span>
				<span className="min-w-0 flex-1 truncate text-ink-muted">{label}</span>
				<ChevronRight
					className={`size-3.5 shrink-0 text-ink-muted transition-transform ${open ? "rotate-90" : "opacity-0 group-hover:opacity-100"}`}
					aria-hidden
				/>
			</button>
			{open && <div className="py-1.5 pl-8">{children}</div>}
		</div>
	);
}

/** The command for `bash`, else the tool name and its first string argument. */
function summarize(call: ToolCall) {
	const command = call.arguments.command;
	if (call.name === "bash" && typeof command === "string") return command;
	const first = Object.values(call.arguments).find((value) => typeof value === "string");
	return typeof first === "string" ? `${call.name} ${first}` : call.name;
}
