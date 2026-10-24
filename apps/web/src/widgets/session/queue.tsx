import type { Delivery, QueuedPrompt } from "@codeworksh/widget/codework";
import { useBus } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { CornerDownRight, ListEnd, type LucideIcon, Pencil, SendHorizontal, Trash2, Undo2 } from "lucide-react";
import { useRef, useState } from "react";

import { Json, topics } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const decodeCancelled = Schema.decodeUnknownOption(Json.Cancelled);
const unreachable = "The CodeWork server is not reachable.";

/**
 * Prompts sent while the agent works and not yet taken in, tucked behind the composer's top edge
 * like a notice: steers join at the agent's next step, follow-ups after its turn. Each leaves once
 * it is in the conversation, or once removed. Past four, a count heads the list and it scrolls,
 * cut mid-row and faded at its edges so more reads as more.
 *
 * A row moves to the other lane (or, while idle, sends now), is rewritten in place, goes back to the
 * composer, or is removed. Every action is a request on the session backend; the row changes when
 * the queue next updates.
 */
export function Queue({
	sessionId,
	queued,
	running,
	onError,
	onRestore,
}: {
	readonly sessionId: string;
	readonly queued: readonly QueuedPrompt[];
	readonly running: boolean;
	readonly onError: (message: string | undefined) => void;
	/** Puts a withdrawn prompt's text back in the composer. */
	readonly onRestore: (text: string) => void;
}) {
	const bus = useBus();
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
		try {
			await request();
		} catch {
			onError(unreachable);
		} finally {
			setBusy((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
		}
	};

	const change = (prompt: QueuedPrompt, patch: { readonly delivery?: Delivery; readonly text?: string }) =>
		act(prompt.id, async () => {
			const answer = await bus.request({
				topic: topics.change,
				payload: { sessionId, messageId: prompt.id, ...patch },
			});
			const reply = decodeReply(answer.payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") onError(reply.value.message);
		});

	// Undo restores only what it took back: a prompt the agent already took in stays in the conversation.
	const cancel = (prompt: QueuedPrompt, restore: boolean) =>
		act(prompt.id, async () => {
			const answer = await bus.request({ topic: topics.cancel, payload: { sessionId, messageId: prompt.id } });
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

	const many = queued.length > 4;
	return (
		<div className="mx-5.5 -mb-4 rounded-t-2xl border border-b-0 border-edge bg-frame px-3 pt-2 pb-6 text-xs leading-snug">
			{queued.length > 3 && <p className="pb-1 font-medium text-ink-muted tabular-nums">{queued.length} queued</p>}
			<ol
				aria-label="Queued messages"
				className={`flex flex-col gap-0.5 ${many ? "max-h-[97px] overflow-y-auto mask-[linear-gradient(to_bottom,transparent,black_6px,black_calc(100%-10px),transparent)]" : ""}`}
			>
				{queued.map((prompt) => {
					const steer = prompt.delivery === "steer";
					const Icon = steer ? CornerDownRight : ListEnd;
					const pending = busy.has(prompt.id);
					const draft = editing?.id === prompt.id ? editing.text : undefined;
					// While idle both lanes wait for a wake, so the lane action is "send now".
					const lane: { readonly label: string; readonly icon: LucideIcon; readonly delivery: Delivery } = !running
						? { label: "Send now", icon: SendHorizontal, delivery: "steer" }
						: steer
							? { label: "Queue as follow-up", icon: ListEnd, delivery: "followUp" }
							: { label: "Steer now", icon: CornerDownRight, delivery: "steer" };
					return (
						<li
							key={prompt.id}
							className={`group flex min-w-0 items-center gap-2 ${pending ? "opacity-50" : ""}`}
						>
							<Icon className="size-3.5 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden />
							<span className="shrink-0 font-medium text-ink-muted">{steer ? "Steer" : "Follow-up"}</span>
							{draft !== undefined ? (
								<input
									aria-label="Edit queued message"
									autoFocus
									value={draft}
									onChange={(event) => setEditing({ id: prompt.id, text: event.target.value })}
									onKeyDown={(event) => {
										if (event.key === "Enter" && !event.nativeEvent.isComposing) {
											event.preventDefault();
											save(prompt, draft);
										} else if (event.key === "Escape") {
											event.preventDefault();
											event.stopPropagation();
											close();
										}
									}}
									onBlur={() => save(prompt, draft)}
									className="h-5 min-w-0 flex-1 rounded-md border border-edge bg-frame-top px-1.5 text-ink outline-none focus-visible:border-edge-focus"
								/>
							) : (
								<span title={prompt.text} className="min-w-0 flex-1 truncate text-ink">
									{prompt.text}
								</span>
							)}
							<div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
								<Action
									label={lane.label}
									icon={lane.icon}
									disabled={pending}
									onClick={() => void change(prompt, { delivery: lane.delivery })}
								/>
								<Action
									label="Edit"
									icon={Pencil}
									disabled={pending}
									onClick={() => edit(prompt.id, prompt.text)}
								/>
								<Action
									label="Back to composer"
									icon={Undo2}
									disabled={pending}
									onClick={() => void cancel(prompt, true)}
								/>
								<Action
									label="Remove"
									icon={Trash2}
									danger
									disabled={pending}
									onClick={() => void cancel(prompt, false)}
								/>
							</div>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

function Action({
	label,
	icon: Icon,
	danger = false,
	disabled,
	onClick,
}: {
	readonly label: string;
	readonly icon: LucideIcon;
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
			className={`grid size-5 place-items-center rounded-md text-ink-muted transition-colors outline-none hover:bg-ink/8 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none ${danger ? "hover:text-destructive" : "hover:text-ink"}`}
		>
			<Icon className="size-3" strokeWidth={1.75} aria-hidden />
		</button>
	);
}
