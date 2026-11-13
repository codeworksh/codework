import {
	ArrowBendDownRightIcon,
	ArrowCounterClockwiseIcon,
	type Icon,
	ListPlusIcon,
	PaperPlaneRightIcon,
	PencilSimpleIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import type { Delivery, QueuedPrompt } from "@codeworksh/widget/codework";
import { useBus } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { memo, useRef, useState } from "react";

import { Json, type ThreadRef, topics } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeCancelled = Schema.decodeUnknownOption(Json.Cancelled);
const unreachable = "The CodeWork server is not reachable.";

/** The shape of a card stacked on the composer's top edge, a queued prompt or a notice; each brings its own colors. */
export const trayCard =
	"border border-b-0 px-3 text-ui text-ink shadow-[0_-2px_6px_-3px_rgb(0_0_0/0.12)] backdrop-blur-xl";

/** A card's height, how much of each card behind the front one shows, and how many show at most. */
const ROW = 32;
const PEEK = 7;
const PEEKS = 3;
/** How much narrower each card further back is, per side. */
const INSET = 8;
/** Without hover the stack cannot open on demand, so it stays open. */
const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * Prompts sent while the agent works and not yet taken in, tucked behind the composer's top edge
 * like a notice: steers join at the agent's next step, follow-ups after its turn. Each leaves once
 * it is in the conversation, or once removed. Several stack as cards, the newest in front, all behind
 * a notice when there is one; hovering or focusing the stack opens it.
 *
 * A row moves to the other lane (or, while idle, sends now), is rewritten in place, goes back to the
 * composer, or is removed. Every action is a request on the session backend; the row changes when
 * the queue next updates.
 */
export const Queue = memo(function Queue({
	thread,
	queued,
	running,
	parked,
	behind,
	onError,
	onRestore,
}: {
	readonly thread: ThreadRef;
	readonly queued: readonly QueuedPrompt[];
	readonly running: boolean;
	/** Left waiting by a stop or a failure: they run with the next message, not by themselves. */
	readonly parked: boolean;
	/** A notice holds the front: every prompt sits behind it, and the stack opens above it. */
	readonly behind: boolean;
	readonly onError: (message: string | undefined) => void;
	/** Puts a withdrawn prompt's text back in the composer. */
	readonly onRestore: (text: string) => void;
}) {
	const bus = useBus();
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	// Rows with a request out; their actions wait for its answer.
	const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
	const [editing, setEditing] = useState<{ readonly id: string; readonly text: string }>();
	// The row being edited, read by the blur that follows Enter or Escape unmounting the input, so
	// an edit is saved once and an escaped one not at all.
	const open = useRef<string>(undefined);
	const edit = (id: string, text: string) => {
		open.current = id;
		setEditing({ id, text });
	};
	const close = () => {
		open.current = undefined;
		setEditing(undefined);
	};

	const act = async (id: string, request: () => Promise<void>) => {
		onError(undefined);
		setBusy((current) => new Set(current).add(id));
		await request().catch(() => onError(unreachable));
		setBusy((current) => {
			const next = new Set(current);
			next.delete(id);
			return next;
		});
	};

	const change = (prompt: QueuedPrompt, patch: { readonly delivery?: Delivery; readonly text?: string }) =>
		act(prompt.id, async () => {
			const answer = await bus.request({
				topic: topics.change,
				payload: { ...thread, messageId: prompt.id, ...patch },
			});
			const reply = decodeReply(answer.payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") onError(reply.value.message);
		});

	// Undo restores only what it took back: a prompt the agent already took in stays in the conversation.
	const cancel = (prompt: QueuedPrompt, restore: boolean) =>
		act(prompt.id, async () => {
			const answer = await bus.request({ topic: topics.cancel, payload: { ...thread, messageId: prompt.id } });
			const reply = Option.getOrUndefined(decodeCancelled(answer.payload));
			if (reply?._tag === "Failed") onError(reply.message);
			else if (reply?._tag === "Cancelled" && restore) onRestore(prompt.text);
			else if (reply?._tag === "Sent" && restore) onError("That message was already sent.");
		});

	const save = (prompt: QueuedPrompt, text: string) => {
		if (open.current !== prompt.id) return;
		close();
		const trimmed = text.trim();
		if (trimmed === "" || trimmed === prompt.text) return;
		void change(prompt, { text: trimmed });
	};

	// Collapsed, the next prompts peek above the front one as a stack; open, every card shows. Open
	// overflows upward from a fixed footprint, so it never moves the conversation underneath.
	const spread = hovered || focused || editing !== undefined || coarse;
	// Behind a notice the newest prompt is one step back too, so only edges show.
	const lift = behind ? 1 : 0;
	const peeks = Math.min(queued.length - 1 + lift, PEEKS);
	return (
		<div
			className="relative mx-2"
			style={{ height: (behind ? 0 : ROW) + peeks * PEEK }}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<ol
				aria-label="Queued messages"
				// Behind a notice, the last card's hidden lower part runs under it; open, the list lifts clear.
				style={{ bottom: !behind ? 0 : spread ? 4 : PEEK - ROW }}
				className="absolute inset-x-0 isolate flex flex-col transition-[bottom] duration-200 ease-out motion-reduce:transition-none"
			>
				{queued.map((prompt, index) => {
					// 0 is the front card, against the composer; higher sits further back.
					const depth = queued.length - 1 - index + lift;
					const last = index === queued.length - 1;
					const hidden = !spread && depth > PEEKS;
					const steer = prompt.delivery === "steer";
					const pending = busy.has(prompt.id);
					const draft = editing?.id === prompt.id ? editing.text : undefined;
					// While idle both lanes wait for a wake, so the lane action is "send now".
					const lane: { readonly label: string; readonly icon: Icon; readonly delivery: Delivery } = !running
						? { label: "Send Now", icon: PaperPlaneRightIcon, delivery: "steer" }
						: steer
							? { label: "Queue as Follow Up", icon: ListPlusIcon, delivery: "followUp" }
							: { label: "Steer Now", icon: ArrowBendDownRightIcon, delivery: "steer" };
					return (
						<li
							key={prompt.id}
							inert={hidden}
							style={{
								zIndex: queued.length - depth,
								// Collapsed, each card overlaps the one above it, leaving that one's top edge in view;
								// open, they close up into one list, so nothing behind shows between them.
								marginTop: index === 0 ? 0 : spread ? 0 : depth + 1 > PEEKS ? -ROW : PEEK - ROW,
								marginInline: spread ? 0 : depth * INSET,
								// Further back reads darker, so each edge separates from the card in front of it; only
								// that edge is drawn, so the translucent cards never pile up behind the front one.
								...(spread || depth === 0
									? {}
									: {
											backgroundColor: `color-mix(in oklab, var(--cw-ink) ${depth * 4}%, var(--cw-composer))`,
											clipPath: `inset(0 0 ${ROW - PEEK}px 0)`,
										}),
							}}
							className={`group relative flex h-8 min-w-0 items-center ${trayCard} border-ink/10 bg-(--cw-composer) transition-[margin,opacity,border-radius,background-color,clip-path] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none ${spread && index > 0 ? "rounded-t-none" : "rounded-t-lg"} ${spread && behind && last ? "rounded-b-lg border-b" : ""} ${hidden ? "opacity-0" : ""} ${pending ? "text-ink-muted" : ""}`}
						>
							<div
								className={`flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-200 ease-out ${spread || depth === 0 ? "" : "opacity-0"}`}
							>
								{parked && (
									// A slow beat: waiting on the next message, not running and not lost.
									<span
										role="img"
										aria-label="Parked: runs with your next message"
										title="Runs with your next message"
										className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink-muted motion-reduce:animate-none"
									/>
								)}
								{draft !== undefined ? (
									// The text turns editable where it sits: a faint tint, no box, nothing moves.
									<form
										className="flex min-w-0 flex-1"
										onSubmit={(event) => {
											event.preventDefault();
											save(prompt, draft);
										}}
									>
										<input
											aria-label="Edit queued message"
											autoFocus
											autoComplete="off"
											data-1p-ignore
											value={draft}
											onChange={(event) => setEditing({ id: prompt.id, text: event.target.value })}
											onKeyDown={(event) => {
												if (event.key !== "Escape") return;
												event.preventDefault();
												event.stopPropagation();
												close();
											}}
											onBlur={() => save(prompt, draft)}
											className="-mx-1.5 h-6 min-w-0 flex-1 rounded-md bg-ink/5 px-1.5 text-ink outline-none pointer-coarse:text-base"
										/>
									</form>
								) : (
									<span title={prompt.text} className="min-w-0 flex-1 truncate py-1">
										{prompt.text}
									</span>
								)}
								{draft !== undefined ? (
									<span className="shrink-0 text-2xs text-ink-muted">↵ Save · Esc Cancel</span>
								) : (
									<>
										{/* The lane is how it runs, not part of the message: it trails, small and muted, and
										    gives way to the row's actions on hover. */}
										<span className="shrink-0 text-2xs text-ink-muted pointer-fine:group-focus-within:hidden pointer-fine:group-hover:hidden">
											{steer ? "Steer" : "Follow Up"}
										</span>
										<div className="flex shrink-0 items-center pointer-fine:hidden pointer-fine:group-focus-within:flex pointer-fine:group-hover:flex">
											<Action
												label={lane.label}
												icon={lane.icon}
												disabled={pending}
												onClick={() => void change(prompt, { delivery: lane.delivery })}
											/>
											<Action
												label="Edit"
												icon={PencilSimpleIcon}
												disabled={pending}
												onClick={() => edit(prompt.id, prompt.text)}
											/>
											<Action
												label="Back to Composer"
												icon={ArrowCounterClockwiseIcon}
												disabled={pending}
												onClick={() => void cancel(prompt, true)}
											/>
											<Action
												label="Remove"
												icon={TrashIcon}
												danger
												disabled={pending}
												onClick={() => void cancel(prompt, false)}
											/>
										</div>
									</>
								)}
							</div>
						</li>
					);
				})}
			</ol>
		</div>
	);
});

function Action({
	label,
	icon: Icon,
	danger = false,
	disabled,
	onClick,
}: {
	readonly label: string;
	readonly icon: Icon;
	readonly danger?: boolean;
	readonly disabled: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`grid size-6 shrink-0 place-items-center rounded-md text-ink-muted transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-ink/8 focus-visible:ring-2 focus-visible:ring-ring enabled:active:scale-95 disabled:pointer-events-none ${danger ? "hover:text-destructive" : "hover:text-ink"}`}
		>
			<Icon className="size-3.5" aria-hidden />
		</button>
	);
}
