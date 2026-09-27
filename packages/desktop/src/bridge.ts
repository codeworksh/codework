export const DefaultUrl = "ws://127.0.0.1:7433/rpc";

/** Sidebar sentinel for sessions that were never anchored to a host directory. */
export const UnlinkedRepo = "__unlinked__";

export interface RepoRow {
	readonly path: string;
	readonly name: string;
}

export interface RepoState {
	readonly repos: ReadonlyArray<RepoRow>;
	readonly selected?: string;
}

export interface SessionRow {
	readonly id: string;
	readonly title: string;
	readonly directory: string;
	readonly hostDir?: string;
}

export interface ChatMessage {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly content: string;
}

export type LiveEvent =
	| { readonly kind: "user"; readonly sessionId: string; readonly id: string; readonly content: string }
	| { readonly kind: "delta"; readonly sessionId: string; readonly delta: string }
	| { readonly kind: "assistant"; readonly sessionId: string; readonly id: string; readonly content: string }
	| { readonly kind: "ended"; readonly sessionId: string; readonly outcome: "succeeded" }
	| { readonly kind: "ended"; readonly sessionId: string; readonly outcome: "failed"; readonly message: string }
	| { readonly kind: "ended"; readonly sessionId: string; readonly outcome: "interrupted" };

export type Status =
	| { readonly connected: true; readonly url: string }
	| { readonly connected: false; readonly url: string; readonly error: string };

export type ConnectResult =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly error: string };

export interface DesktopApi {
	readonly connect: (url?: string) => Promise<ConnectResult>;
	readonly disconnect: () => Promise<void>;
	readonly repos: {
		readonly list: () => Promise<RepoState>;
		readonly open: () => Promise<RepoState | undefined>;
		readonly select: (path: string) => Promise<RepoState>;
		readonly remove: (path: string) => Promise<RepoState>;
	};
	readonly sessions: {
		readonly list: () => Promise<ReadonlyArray<SessionRow>>;
		readonly create: (input?: { readonly title?: string; readonly hostDir?: string }) => Promise<SessionRow>;
		readonly prompt: (input: { readonly sessionId: string; readonly text: string }) => Promise<void>;
	};
	readonly onStatus: (callback: (status: Status) => void) => () => void;
	readonly onEvent: (callback: (event: LiveEvent) => void) => () => void;
}
