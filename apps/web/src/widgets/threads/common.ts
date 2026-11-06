import type { ListedThread } from "@codeworksh/contract";
import { toast } from "sonner";

import type { ThreadRef } from "../session/schema";

export const failed = (error: unknown) =>
	toast.error("Not saved", {
		description:
			typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
				? error.message
				: undefined,
	});

/** The thread as the session view names it: its session alone for the main thread. */
export const refOf = (thread: ListedThread): ThreadRef =>
	thread.originKind === "main"
		? { sessionId: thread.sessionId }
		: { sessionId: thread.sessionId, threadId: thread.id };
