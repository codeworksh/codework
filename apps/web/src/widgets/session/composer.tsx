import { useBus, useKv } from "@codeworksh/widget/view";
import { Option, Schema } from "effect";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useState } from "react";

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
		if (sent) setText("");
	};

	const configure = (change: { model?: ModelRef; thinkingLevel?: ThinkingLevel }) => {
		setPicked((current) => ({ ...current, ...change }));
		void ask(topics.configure, encodeConfigure({ sessionId, ...change }));
	};

	const empty = text.trim() === "";
	return (
		<Composer
			value={text}
			onChange={setText}
			onSubmit={(submit) => void send(submit)}
			placeholder={running ? "Steer the agent, or queue a follow-up" : "Ask for changes or send a follow-up"}
			controls={
				<>
					<ModelPicker hostDir={info.hostDir} value={model} onChange={(next) => configure({ model: next })} />
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
					<ComposerButton label={running ? "Steer" : "Send"} disabled={empty || pending}>
						<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
					</ComposerButton>
				</>
			}
		/>
	);
}
