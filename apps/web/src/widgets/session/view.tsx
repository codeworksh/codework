import type { HistoryEntry, Part, ToolCall } from "@codeworksh/widget/codework";
import { useBus, useEvents, useFrame, useKv, type WidgetProps } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { Brain, ChevronDown, ChevronRight, CircleAlert, MessageSquareText, Terminal, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ago } from "../time";
import { sessionId } from "./address";
import { SessionComposer } from "./composer";
import { Markdown } from "./markdown";
import { type Info, Json, snapshotKey, topics, type Update } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeSnapshot = Schema.decodeUnknownOption(Json.Snapshot);
const decodeUpdate = Schema.decodeUnknownOption(Json.Update);

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
			readonly messages: readonly HistoryEntry[];
			/** The snapshot's seq: updates are read from after it. */
			readonly after: number;
			/** Whether the agent works, once the backend has said; until then a draft reply implies it. */
			readonly running: boolean | undefined;
	  };

const apply = (state: State, update: Update): State => {
	if (state.status !== "ready") return state;
	switch (update._tag) {
		case "Info":
			return { ...state, info: update.info };
		case "Removed":
			return { ...state, messages: state.messages.filter((message) => message.id !== update.id) };
		case "Running":
			return { ...state, running: update.running };
		case "Message": {
			const index = state.messages.findIndex((message) => message.id === update.message.id);
			// A streamed draft can land just after the reply it belongs to ended; an ended reply stays ended.
			if (index !== -1 && update.message.state === "draft" && state.messages[index]?.state !== "draft") return state;
			return {
				...state,
				messages: index === -1 ? [...state.messages, update.message] : state.messages.with(index, update.message),
			};
		}
	}
};

/**
 * Asks the session backend to follow the session, loads the snapshot it stored, then applies every
 * update published after that snapshot. A dropped connection resumes where it left off.
 */
function useConversation(id: string): State {
	const bus = useBus();
	const kv = useKv();
	const [state, setState] = useState<State>({ status: "loading" });

	useEffect(() => {
		let active = true;
		const fail = (message: string) => {
			if (active) setState({ status: "failed", message });
		};
		void (async () => {
			const reply = decodeReply((await bus.request({ topic: topics.follow, payload: { sessionId: id } })).payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") return fail(reply.value.message);
			const snapshot = decodeSnapshot(await kv.get(snapshotKey(id)));
			if (Option.isNone(snapshot)) return fail(`Could not load session ${id}.`);
			const { info, messages, seq } = snapshot.value;
			if (active) setState({ status: "ready", info, messages, after: seq, running: undefined });
		})().catch(() => fail("The CodeWork server is not reachable."));
		return () => {
			active = false;
		};
	}, [bus, kv, id]);

	const after = state.status === "ready" ? state.after : undefined;
	useEvents(after === undefined ? undefined : { topics: [topics.session(id)], after }, (item) => {
		if ("_tag" in item) return;
		const update = decodeUpdate(item.payload);
		if (Option.isSome(update)) setState((current) => apply(current, update.value));
	});

	return state;
}

function Conversation({ id, instanceId }: { readonly id: string; readonly instanceId: string }) {
	const { setTitle, setIcon, setTab } = useFrame();
	const state = useConversation(id);
	const title = state.status === "ready" ? state.info.title : undefined;
	const project = state.status === "ready" ? state.info.project?.name : undefined;

	useEffect(() => {
		if (title === undefined) return;
		setTitle(title);
		setIcon(MessageSquareText);
		// While focused, the workspace's tab reads as this session: its project over its title.
		setTab({ title: project ?? "Session", subtitle: title });
	}, [title, project, setTitle, setIcon, setTab]);

	if (state.status === "loading") return null;
	if (state.status === "failed") return <p className="p-3 text-ink-muted">{state.message}</p>;
	const last = state.messages.at(-1);
	const running = state.running ?? (last?.role === "assistant" && last.state === "draft");
	return (
		<div className="flex h-full flex-col">
			<Transcript messages={state.messages} running={running} />
			<div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
				<SessionComposer sessionId={id} instanceId={instanceId} running={running} />
			</div>
		</div>
	);
}

/** The conversation, kept scrolled to its end while the reader is there. */
function Transcript({ messages, running }: { readonly messages: readonly HistoryEntry[]; readonly running: boolean }) {
	const scroller = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight;
	}, [messages]);
	return (
		<div
			ref={scroller}
			onScroll={(event) => {
				const element = event.currentTarget;
				atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
			}}
			className="min-h-0 flex-1 overflow-auto"
		>
			{messages.length === 0 ? (
				<p className="p-3 text-ink-muted">No messages yet.</p>
			) : (
				<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-2 pb-6 text-[14px] leading-relaxed">
					{turnsOf(messages).map((turn, index, turns) => (
						<TurnView
							key={turn.user?.id ?? turn.replies[0]?.id ?? index}
							turn={turn}
							active={running && index === turns.length - 1}
						/>
					))}
				</div>
			)}
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

/**
 * The answer is the last reply's text; everything before it (thinking, tool calls, notes between
 * calls) is the work that led there, folded under one line.
 */
/**
 * What the work log can show: a tool call, readable thinking, or a note between calls. Thinking a
 * provider withholds (redacted, or reasoning sent without a summary) has nothing to show.
 */
const isWork = (part: Part) =>
	part.type === "toolCall" ||
	(part.type === "thinking" && part.redacted !== true && part.thinking.trim() !== "") ||
	(part.type === "text" && part.text.trim() !== "");

function TurnView({ turn, active }: { readonly turn: Turn; readonly active: boolean }) {
	const last = turn.replies.at(-1);
	const answer = last?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) ?? [];
	const work = turn.replies
		.flatMap((reply) => reply.parts.filter((part) => !(reply === last && part.type === "text")))
		.filter(isWork);
	const interrupted = last?.state === "aborted";
	// While the agent works and no answer is streaming, it is thinking or running a tool.
	const thinking = active && (last?.state !== "draft" || answer.length === 0);

	return (
		<section className="flex flex-col gap-3">
			{turn.user !== undefined && <UserMessage entry={turn.user} />}
			{work.length > 0 && (
				<WorkLog
					parts={work}
					started={turn.user?.createdAt}
					ended={active ? undefined : endOf(turn.replies)}
					at={last?.updatedAt}
				/>
			)}
			{thinking && <ThinkingRow />}
			{answer.length > 0 && (
				<div className="text-ink/90">
					<Markdown text={answer.join("\n\n")} />
				</div>
			)}
			{interrupted && <p className="text-[12px] text-ink-muted">Interrupted</p>}
		</section>
	);
}

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
		<div className="flex justify-end">
			<div className="max-w-[80%] rounded-2xl bg-ink/6 px-3.5 py-2.5 whitespace-pre-wrap text-ink">
				{text}
				{images > 0 && (
					<p className="mt-1 text-[12px] text-ink-muted">{images === 1 ? "1 image" : `${images} images`}</p>
				)}
			</div>
		</div>
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
	at,
}: {
	readonly parts: readonly Part[];
	readonly started: number | undefined;
	/** Absent while the turn is still running. */
	readonly ended: number | undefined;
	readonly at: number | undefined;
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
			<div className="flex items-center gap-2 border-b border-edge pb-1.5">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className="-mx-1 flex items-center gap-1 rounded-md px-1 text-ink transition-colors hover:bg-ink/5"
				>
					{label}
					{open ? (
						<ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
					) : (
						<ChevronRight className="size-3.5 text-ink-muted" aria-hidden />
					)}
				</button>
				{at !== undefined && <span className="ml-auto text-[12px] text-ink-muted tabular-nums">{ago(at)}</span>}
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
				<div className="py-1 text-ink/80">
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
			<div className="flex flex-col gap-2 font-mono text-[12px]">
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
