import { isMac, useBus, useKv } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { Composer, ComposerButton, type Submit } from "@/components/composer";
import { type Delivery } from "@codeworksh/widget/codework";
import { Json, topics } from "./schema";

const decodeReply = Schema.decodeUnknownOption(Json.Reply);
const encodePrompt = Schema.encodeSync(Json.Prompt);

const draftKey = (instanceId: string) => `widget/${instanceId}/draft`;

/** While the agent works, a prompt steers its turn, and Mod+Enter queues it for after. */
const deliveryFor = (running: boolean, submit: Submit): Delivery | undefined =>
	running ? (submit.alternate ? "followUp" : "steer") : undefined;

const unreachable = "The CodeWork server is not reachable.";

/**
 * The Session widget's prompt box. A send is a request on the session backend's prompt topic, with
 * an id the view chooses for the user message it becomes; the message itself arrives as an update.
 * The text stays until the backend accepts it, and the unsent draft survives a remount.
 */
export function SessionComposer({
	sessionId,
	instanceId,
	running,
}: {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly running: boolean;
}) {
	const bus = useBus();
	const kv = useKv();
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();

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
		setError(undefined);
		try {
			const reply = decodeReply((await bus.request({ topic, payload })).payload);
			if (Option.isSome(reply) && reply.value._tag === "Failed") {
				setError(reply.value.message);
				return false;
			}
			return true;
		} catch {
			setError(unreachable);
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
		if (sent) setText("");
	};

	const empty = text.trim() === "";
	return (
		<Composer
			value={text}
			onChange={setText}
			onSubmit={(submit) => void send(submit)}
			placeholder={running ? "Steer the agent, or queue a follow-up" : "Ask for changes or send a follow-up"}
			actions={
				<>
					{running && (
						<ComposerButton label="Stop" onClick={() => void ask(topics.interrupt, { sessionId })}>
							<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden />
						</ComposerButton>
					)}
					<ComposerButton label={running ? "Steer" : "Send"} disabled={empty || pending}>
						<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
					</ComposerButton>
				</>
			}
			tray={
				error !== undefined ? (
					<span className="px-1.75 py-1 text-destructive">{error}</span>
				) : running ? (
					<span className="px-1.75 py-1">{isMac ? "⌘" : "Ctrl"}+Enter queues it for after this turn</span>
				) : undefined
			}
		/>
	);
}
