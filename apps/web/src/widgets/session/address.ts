import type { ThreadRef } from "./schema";

const prefix = "codework://session/";

/** A session's address: its main thread's. Another thread's is `<session address>/<thread id>`. */
export const sessionAddress = (id: string) => `${prefix}${id}`;

export const threadAddress = ({ sessionId, threadId }: ThreadRef) =>
	threadId === undefined ? sessionAddress(sessionId) : `${sessionAddress(sessionId)}/${threadId}`;

export const threadRef = (address: string | undefined): ThreadRef | undefined => {
	if (!address?.startsWith(prefix)) return undefined;
	const [sessionId, threadId, ...rest] = address.slice(prefix.length).split("/");
	if (sessionId === undefined || sessionId === "" || threadId === "" || rest.length > 0) return undefined;
	return threadId === undefined ? { sessionId } : { sessionId, threadId };
};
