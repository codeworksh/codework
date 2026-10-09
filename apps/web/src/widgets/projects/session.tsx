import { useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { MessageSquareText } from "lucide-react";
import { useEffect } from "react";

import { Server, useFrame, type WidgetProps } from "../../sdk";
import { sessionId } from "./address";

const sessions = Atom.family((id: string) => Server.query("sessions.get", { id }));

export function Session({ address }: WidgetProps<unknown>) {
	const id = sessionId(address);
	if (id === undefined) return <p className="p-3 text-ink-muted">Not a session: {address}</p>;
	return <Conversation id={id} />;
}

function Conversation({ id }: { readonly id: string }) {
	const { setTitle, setIcon } = useFrame();
	const result = useAtomValue(sessions(id));
	const title = AsyncResult.isSuccess(result) ? result.value.title : undefined;

	useEffect(() => {
		if (title === undefined) return;
		setTitle(title);
		setIcon(MessageSquareText);
	}, [title, setTitle, setIcon]);

	return AsyncResult.match(result, {
		onInitial: () => null,
		onFailure: () => <p className="p-3 text-ink-muted">Could not load session {id}.</p>,
		onSuccess: ({ value: session }) => (
			<div className="flex h-full flex-col gap-2 overflow-auto px-3 pb-3">
				<p className="text-ink-muted">{session.project}</p>
				{session.messages.map((message, index) => (
					<p
						key={index}
						className={`max-w-[85%] rounded-xl px-3 py-2 ${message.role === "user" ? "self-end bg-ink/8" : "self-start"}`}
					>
						{message.text}
					</p>
				))}
			</div>
		),
	});
}
