import { useBus, useKv } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { CornerDownLeft, Reply, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Composer, ComposerButton, type Submit } from "@/components/composer";
import { ModelPicker, type ModelRef, ThinkingPicker } from "@/components/model";
import type { Delivery, ThinkingLevel } from "@codeworksh/widget/codework";
import { type Info, Json, topics } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const encodePrompt = Schema.encodeSync(Json.Prompt);
const encodeConfigure = Schema.encodeSync(Json.Configure);

const draftKey = (instanceId: string) => `widget/${instanceId}/draft`;

/** While the agent works, a prompt steers its turn, and Mod+Enter queues it for after. */
const deliveryFor = (running: boolean, submit: Submit): Delivery | undefined =>
	running ? (submit.alternate ? "followUp" : "steer") : undefined;

const unreachable = "The CodeWork server is not reachable.";

/**
 * The Session widget's prompt box. A send is a request on the session backend's prompt topic, with
 * an id the view chooses for the user message it becomes; the message itself arrives as an update.
 * The text stays until the backend accepts it, and the unsent draft survives a remount.
 *
 * The model and reasoning pickers show the session's own choice, which CodeWork keeps with the
 * session; a pick shows at once and is sent as a configure request, applying from the next exchange.
 */
export function SessionComposer({
	sessionId,
	instanceId,
	running,
	info,
	onError,
}: {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly running: boolean;
	readonly info: Info;
	/** A send or configure the backend refused, or undefined as a new one starts; the view shows it. */
	readonly onError: (message: string | undefined) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const [expanded, setExpanded] = useState(false);
	const expand = () => setExpanded(true);
	const collapse = () => {
		input.current?.blur();
		setExpanded(false);
	};
	useEffect(() => {
		if (expanded) input.current?.focus();
	}, [expanded]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.isComposing ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				event.key.toLowerCase() !== "r"
			)
				return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || target.closest("input, textarea, select, [role='dialog'], [role='menu']"))
			)
				return;
			if (
				root.current?.closest("article[data-focused='true']") === null ||
				!root.current?.getClientRects().length ||
				window.getSelection()?.toString()
			)
				return;
			event.preventDefault();
			setExpanded(true);
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				!(target instanceof Element) ||
				root.current?.contains(target) ||
				target.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='menu']")
			)
				return;
			setExpanded(false);
		};
		window.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, []);
	const bus = useBus();
	const kv = useKv();
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [pending, setPending] = useState(false);
	// Picks not yet reflected in the session's info; the info wins once it carries them.
	const [picked, setPicked] = useState<{ model?: ModelRef; thinkingLevel?: ThinkingLevel }>({});
	const model = picked.model ?? info.model;
	const thinkingLevel = picked.thinkingLevel ?? info.thinkingLevel;

	useEffect(() => {
		let active = true;
		void kv
			.get(draftKey(instanceId))
			.then((draft) => {
				if (active && typeof draft === "string") setText((current) => (current === "" ? draft : current));
			})
			.finally(() => {
				if (active) setLoaded(true);
			});
		return () => {
			active = false;
		};
	}, [kv, instanceId]);

	// Saved only once loaded, so the empty initial text never overwrites a stored draft.
	useEffect(() => {
		if (!loaded) return;
		const timer = setTimeout(() => void kv.set(draftKey(instanceId), text), 400);
		return () => clearTimeout(timer);
	}, [kv, instanceId, loaded, text]);

	const ask = async (topic: string, payload: Schema.Json) => {
		onError(undefined);
		try {
			const reply = decodeReply((await bus.request({ topic, payload })).payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") {
				onError(reply.value.message);
				return false;
			}
			return true;
		} catch {
			onError(unreachable);
			return false;
		}
	};

	const send = async (submit: Submit) => {
		const prompt = text.trim();
		if (prompt === "" || pending) return;
		const delivery = deliveryFor(running, submit);
		setPending(true);
		const sent = await ask(
			topics.prompt,
			encodePrompt({
				sessionId,
				messageId: crypto.randomUUID(),
				text: prompt,
				...(delivery === undefined ? {} : { delivery }),
			}),
		);
		setPending(false);
		if (sent) {
			setText("");
			collapse();
		}
	};

	const configure = (change: { model?: ModelRef; thinkingLevel?: ThinkingLevel }) => {
		setPicked((current) => ({ ...current, ...change }));
		void ask(topics.configure, encodeConfigure({ sessionId, ...change }));
	};

	const empty = text.trim() === "";
	return (
		<div
			ref={root}
			onKeyDown={(event) => {
				if (expanded && event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					event.stopPropagation();
					collapse();
				}
			}}
		>
			{!expanded ? (
				<button
					type="button"
					onClick={expand}
					aria-label="Write a reply"
					className="flex h-12 w-full items-center gap-2 rounded-xl border border-edge bg-frame-top/95 px-4 text-left text-[13px] text-ink-muted shadow-frame outline-none hover:border-edge-focus focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Reply className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
					<span className="min-w-0 flex-1 truncate">{text || "Write a reply…"}</span>
					<kbd className="rounded border border-edge px-1 text-[10px]">R</kbd>
				</button>
			) : (
				<Composer
					inputRef={input}
					onEscape={collapse}
					className="rounded-xl bg-frame-top [&_textarea]:rounded-lg [&_textarea]:bg-ink/4 [&_textarea]:px-3 [&_textarea]:py-2"
					header={
						<div className="flex h-10 items-center gap-2 px-4 text-[12px] text-ink-muted">
							<Reply className="size-3.5 text-brand" aria-hidden />
							<span className="flex-1 font-medium text-ink">Reply</span>
							<button
								type="button"
								onClick={collapse}
								aria-label="Minimize reply"
								className="flex items-center gap-2 rounded p-1 hover:bg-ink/5"
							>
								<kbd className="text-[10px]">esc</kbd>
								<X className="size-3.5" aria-hidden />
							</button>
						</div>
					}

					value={text}
					onChange={setText}
					onSubmit={(submit) => void send(submit)}
					placeholder={running ? "Steer the agent, or queue a follow-up" : "Ask for changes or send a follow-up"}
					controls={
						<>
							<ModelPicker
								hostDir={info.hostDir}
								value={model}
								onChange={(next) => configure({ model: next })}
							/>
							<ThinkingPicker
								hostDir={info.hostDir}
								model={model}
								value={thinkingLevel}
								onChange={(level) => configure({ thinkingLevel: level })}
							/>
						</>
					}
					actions={
						<>
							{running && (
								<ComposerButton label="Stop" onClick={() => void ask(topics.interrupt, { sessionId })}>
									<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden />
								</ComposerButton>
							)}
							<button
								type="submit"
								disabled={empty || pending}
								className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-brand px-3 text-[12px] font-medium text-brand-ink press disabled:opacity-50"
								title={running ? "Steer now; Mod+Enter queues a follow-up" : "Reply (Enter)"}
							>
								{running ? "Steer" : "Reply"}
								<span className="flex items-center gap-0.5 opacity-70" aria-hidden>
									<CornerDownLeft className="size-3.5" />
								</span>
							</button>
						</>
					}
				/>
			)}
		</div>
	);
}
