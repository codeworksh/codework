import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Model } from "@codeworksh/aikit";
import { EventList, type EventSchema, Session } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";
import { Client } from "../../codework/src/server/client.ts";

export const DEFAULT_SERVER_URL = "ws://127.0.0.1:7433/rpc";

export interface SessionInfoResult {
	readonly id: string;
	readonly title: string;
	readonly directory: string;
}

export interface UsageReport {
	readonly totalTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
	readonly model?: string;
}

export interface StreamCallbacks {
	readonly onTextDelta?: (delta: string) => void;
	readonly onThinkingDelta?: (delta: string) => void;
	readonly onToolStarted?: (tool: { readonly name: string; readonly label?: string }) => void;
	readonly onToolSettled?: (tool: { readonly name: string }) => void;
	readonly onUsage?: (usage: UsageReport) => void;
	readonly onComplete?: () => void;
	readonly onError?: (error: string) => void;
}

function withClient<T>(url: string, fn: (rpc: Client.Client) => Effect.Effect<T, unknown, never>): Promise<T> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const rpc = yield* Client.make;
			return yield* fn(rpc);
		}).pipe(Effect.provide(Client.layer(url)), Effect.scoped),
	);
}

/**
 * Checks whether the CodeWork RPC server is responding.
 */
export async function isServerRunning(url = DEFAULT_SERVER_URL): Promise<boolean> {
	try {
		await withClient(url, (rpc) => rpc["session.list"]({}).pipe(Effect.timeout("1500 millis")));
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensures the CodeWork RPC server is running, spawning `codework serve` if not yet listening.
 */
export async function ensureServerRunning(url = DEFAULT_SERVER_URL): Promise<boolean> {
	if (await isServerRunning(url)) {
		return true;
	}

	const candidates = [
		path.resolve(process.cwd(), "packages/codework/src/index.ts"),
		path.resolve(import.meta.dirname, "../../codework/src/index.ts"),
	];
	const entry = candidates.find((c) => existsSync(c));
	if (!entry) {
		return false;
	}

	try {
		const child = spawn(process.execPath, [entry, "serve"], {
			detached: true,
			stdio: "ignore",
			cwd: process.cwd(),
		});
		child.unref();

		// Poll for up to 5 seconds
		for (let i = 0; i < 25; i++) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			if (await isServerRunning(url)) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Creates a new session on the RPC server with specified model and cwd.
 */
export async function createSession(options: {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly serverUrl?: string;
}): Promise<SessionInfoResult> {
	const url = options.serverUrl ?? DEFAULT_SERVER_URL;
	const hostDir = Session.AbsolutePath.make(process.cwd());

	const session = await withClient(url, (rpc) =>
		rpc["session.create"]({
			hostDir,
			runtime: {
				model: {
					provider: options.provider,
					id: options.modelId,
				},
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			},
		}).pipe(Effect.timeout("10 seconds")),
	);

	return {
		id: session.id,
		title: session.title,
		directory: session.directory,
	};
}

/**
 * Submits a prompt to an active session and streams events.
 */
export async function promptSession(
	options: {
		readonly sessionId: string;
		readonly text: string;
		readonly serverUrl?: string;
	},
	callbacks: StreamCallbacks,
): Promise<void> {
	const url = options.serverUrl ?? DEFAULT_SERVER_URL;
	const sid = Session.SessionSchema.ID.make(options.sessionId);

	try {
		await withClient(url, (rpc) =>
			Client.run(
				rpc,
				{
					sessionId: sid,
					text: options.text,
				},
				(rpcEvent: EventSchema.Payload) =>
					Effect.sync(() => {
						if (Schema.is(EventList.LLMTextDelta)(rpcEvent)) {
							callbacks.onTextDelta?.(rpcEvent.data.delta);
						} else if (Schema.is(EventList.LLMThinkingDelta)(rpcEvent)) {
							callbacks.onThinkingDelta?.(rpcEvent.data.delta);
						} else if (Schema.is(EventList.ToolStarted)(rpcEvent)) {
							callbacks.onToolStarted?.({
								name: rpcEvent.data.name,
								...(rpcEvent.data.label ? { label: rpcEvent.data.label } : {}),
							});
						} else if (Schema.is(EventList.ToolSettled)(rpcEvent)) {
							callbacks.onToolSettled?.({
								name: rpcEvent.data.callID,
							});
						} else if (Schema.is(EventList.LLMEnded)(rpcEvent)) {
							callbacks.onUsage?.({
								totalTokens: rpcEvent.data.message.usage.totalTokens,
								inputTokens: rpcEvent.data.message.usage.input,
								outputTokens: rpcEvent.data.message.usage.output,
								cost: rpcEvent.data.message.usage.cost.total,
								...(rpcEvent.data.message.responseModel || rpcEvent.data.message.model
									? { model: rpcEvent.data.message.responseModel ?? rpcEvent.data.message.model }
									: {}),
							});
						}
					}),
			),
		);
		callbacks.onComplete?.();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		callbacks.onError?.(message);
		throw error;
	}
}

/**
 * Interrupts current active turn in a session.
 */
export async function interruptSession(sessionId: string, serverUrl = DEFAULT_SERVER_URL): Promise<boolean> {
	try {
		const result = await withClient(serverUrl, (rpc) =>
			rpc["session.interrupt"]({
				sessionId: Session.SessionSchema.ID.make(sessionId),
			}).pipe(Effect.timeout("5 seconds")),
		);
		return result.interrupted;
	} catch {
		return false;
	}
}
