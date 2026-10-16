import { useAtomValue } from "@effect/atom-react";
import type { HistoryEntry, Part, ToolCall } from "@codeworksh/widget/codework";
import { Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { Brain, ChevronDown, ChevronRight, CircleAlert, MessageSquareText, Terminal, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useFrame, type WidgetProps } from "@codeworksh/widget/view";

import { Server } from "../../kernel/rpc";
import { sessionId } from "./address";
import { Markdown } from "./markdown";
import { ago } from "./time";

const sessions = Atom.family((id: string) => Server.query("sessions.get", { id }));

export function Session({ address }: WidgetProps<unknown>) {
	const id = sessionId(address);
	if (id === undefined) return <p className="p-3 text-ink-muted">Not a session: {address}</p>;
	return <Conversation id={id} />;
}

function Conversation({ id }: { readonly id: string }) {
	const { setTitle, setIcon, setTab } = useFrame();
	const result = useAtomValue(sessions(id));
	const title = AsyncResult.isSuccess(result) ? result.value.title : undefined;
	const project = AsyncResult.isSuccess(result) ? result.value.project?.name : undefined;

	useEffect(() => {
		if (title === undefined) return;
		setTitle(title);
		setIcon(MessageSquareText);
		// While focused, the workspace's tab reads as this session: its project over its title.
		setTab({ title: project ?? "Session", subtitle: title });
	}, [title, project, setTitle, setIcon, setTab]);

	return AsyncResult.match(result, {
		onInitial: () => null,
		onFailure: () => (
			<p className="p-3 text-ink-muted">
				{Option.match(AsyncResult.error(result), {
					onSome: (error) =>
						error._tag === "Server.CodeworkUnavailable"
							? error.message
							: error._tag === "Server.SessionNotFound"
								? "This session no longer exists."
								: `Could not load session ${id}.`,
					onNone: () => `Could not load session ${id}.`,
				})}
			</p>
		),
		onSuccess: ({ value: session }) =>
			session.entries.length === 0 ? (
				<p className="p-3 text-ink-muted">No messages yet.</p>
			) : (
				<div className="h-full overflow-auto">
					<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-2 pb-6 text-[14px] leading-relaxed">
						{turnsOf(session.entries).map((turn, index) => (
							<TurnView key={turn.user?.id ?? turn.replies[0]?.id ?? index} turn={turn} />
						))}
					</div>
				</div>
			),
	});
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
function TurnView({ turn }: { readonly turn: Turn }) {
	const last = turn.replies.at(-1);
	const answer = last?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) ?? [];
	const work = turn.replies.flatMap((reply) =>
		reply.parts.filter((part) => !(reply === last && part.type === "text")),
	);
	const interrupted = last?.state === "aborted";

	return (
		<section className="flex flex-col gap-3">
			{turn.user !== undefined && <UserMessage entry={turn.user} />}
			{work.length > 0 && (
				<WorkLog parts={work} started={turn.user?.createdAt} ended={endOf(turn.replies)} at={last?.createdAt} />
			)}
			{answer.length > 0 && (
				<div className="text-ink/90">
					<Markdown text={answer.join("\n\n")} />
				</div>
			)}
			{last?.state === "draft" && <p className="text-[12px] text-ink-muted">Still replying…</p>}
			{interrupted && <p className="text-[12px] text-ink-muted">Interrupted</p>}
		</section>
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

/** The latest moment a turn's work is known to have reached: a reply's start or a tool's last update. */
function endOf(replies: readonly HistoryEntry[]) {
	return Math.max(
		0,
		...replies.flatMap((reply) => [
			reply.createdAt,
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
	readonly ended: number;
	readonly at: number | undefined;
}) {
	const [open, setOpen] = useState(false);
	const label = started !== undefined && ended > started ? `Worked for ${duration(ended - started)}` : "Worked";
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
