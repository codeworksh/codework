import { useEffect, useRef, useState } from "react";
import {
	applyEvent,
	DefaultUrl,
	sessionsFor,
	UnlinkedRepo,
	type ChatMessage,
	type LiveEvent,
	type RepoRow,
	type SessionRow,
	type Status,
} from "./api.ts";
import { AgentMarkdown } from "./markdown.tsx";

const disconnected = (url: string, error: string): Status => ({ connected: false, url, error });

const api = () => {
	if (window.desktop === undefined) throw new Error("Preload bridge missing. Restart the desktop app.");
	return window.desktop;
};

let nextId = 0;
const messageId = () => `msg_${++nextId}`;

const Thread = ({ messages, empty }: { readonly messages: ReadonlyArray<ChatMessage>; readonly empty: string }) => {
	const end = useRef<HTMLDivElement>(null);
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	if (messages.length === 0) {
		return <p className="px-6 py-8 text-sm text-zinc-500">{empty}</p>;
	}

	return (
		<div className="flex flex-col gap-6 px-6 py-5">
			{messages.map((message) =>
				message.role === "user" ? (
					<section key={message.id} className="flex flex-col items-end gap-1.5">
						<span className="text-[11px] font-medium tracking-wide text-zinc-500">You</span>
						<div className="max-w-[min(36rem,85%)] rounded-2xl bg-zinc-800/90 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-zinc-100">
							{message.content}
						</div>
					</section>
				) : (
					<section key={message.id} className="flex flex-col gap-1.5">
						<span className="text-[11px] font-medium tracking-wide text-zinc-500">Agent</span>
						{message.content === "" ? (
							<p className="text-sm text-zinc-500">Thinking…</p>
						) : (
							<AgentMarkdown content={message.content} />
						)}
					</section>
				),
			)}
			<div ref={end} />
		</div>
	);
};

export const App = () => {
	const [status, setStatus] = useState<Status>(disconnected(DefaultUrl, "Not connected"));
	const [repos, setRepos] = useState<ReadonlyArray<RepoRow>>([]);
	const [repo, setRepo] = useState<string>(UnlinkedRepo);
	const [sessions, setSessions] = useState<ReadonlyArray<SessionRow>>([]);
	const [selected, setSelected] = useState<string | undefined>();
	const [prompt, setPrompt] = useState("");
	const [threads, setThreads] = useState<Record<string, ReadonlyArray<ChatMessage>>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const visible = sessionsFor(sessions, repo);
	const canCreate = status.connected && repo !== UnlinkedRepo;

	const applyRepos = (state: { readonly repos: ReadonlyArray<RepoRow>; readonly selected?: string }) => {
		setRepos(state.repos);
		setRepo(state.selected ?? state.repos[0]?.path ?? UnlinkedRepo);
	};

	const refresh = async () => {
		try {
			applyRepos(await api().repos.list());
			const rows = await api().sessions.list();
			setSessions(rows);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	useEffect(() => {
		if (window.desktop === undefined) {
			setStatus(disconnected(DefaultUrl, "Preload bridge missing. Restart the desktop app."));
			return;
		}
		let cancelled = false;
		const stopStatus = window.desktop.onStatus(setStatus);
		const stopEvents = window.desktop.onEvent((event: LiveEvent) => {
			setThreads((current) => ({
				...current,
				[event.sessionId]: applyEvent(current[event.sessionId] ?? [], event),
			}));
			if (event.kind !== "ended") return;
			setBusy(false);
			if (event.outcome === "failed") setError(event.message);
		});
		void window.desktop.connect().then((result) => {
			if (cancelled) return;
			if (!result.ok) {
				setStatus(disconnected(DefaultUrl, result.error));
				return;
			}
			setStatus({ connected: true, url: result.url });
			void refresh();
		});
		return () => {
			cancelled = true;
			stopStatus();
			stopEvents();
		};
	}, []);

	useEffect(() => {
		const next = sessionsFor(sessions, repo);
		setSelected((current) => (next.some((row) => row.id === current) ? current : next[0]?.id));
	}, [repo, sessions]);

	useEffect(() => {
		setBusy(false);
	}, [repo]);

	const create = async () => {
		if (!canCreate) return;
		setError(undefined);
		const name = repos.find((row) => row.path === repo)?.name ?? "Desktop";
		const row = await api().sessions.create({ title: name, hostDir: repo });
		setSessions((current) => [row, ...current]);
		setSelected(row.id);
	};

	const pickRepo = async () => {
		const state = await api().repos.open();
		if (state === undefined) return;
		applyRepos(state);
	};

	const chooseRepo = async (path: string) => {
		applyRepos(await api().repos.select(path));
	};

	const dropRepo = async (path: string) => {
		applyRepos(await api().repos.remove(path));
	};

	const send = async () => {
		if (!canCreate || prompt.trim() === "") return;
		setBusy(true);
		setError(undefined);
		const textToSend = prompt.trim();
		setPrompt("");
		try {
			let sessionId = selected;
			if (sessionId === undefined) {
				const name = repos.find((row) => row.path === repo)?.name ?? "Desktop";
				const row = await api().sessions.create({ title: name, hostDir: repo });
				setSessions((current) => [row, ...current]);
				setSelected(row.id);
				sessionId = row.id;
			}
			setThreads((current) => ({
				...current,
				[sessionId]: [
					...(current[sessionId] ?? []),
					{ id: messageId(), role: "user", content: textToSend },
					{ id: messageId(), role: "assistant", content: "" },
				],
			}));
			await api().sessions.prompt({ sessionId, text: textToSend });
		} catch (cause) {
			setBusy(false);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<div className="flex h-full">
			<aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
				<div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
					<span className="text-sm font-medium">Repos</span>
					<button
						type="button"
						className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
						onClick={() => void pickRepo()}
					>
						Open
					</button>
				</div>
				<ul className="max-h-56 shrink-0 overflow-y-auto p-2">
					{repos.map((row) => (
						<li key={row.path} className="flex items-center gap-1">
							<button
								type="button"
								className={`min-w-0 flex-1 rounded px-3 py-2 text-left text-sm ${
									row.path === repo ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900"
								}`}
								onClick={() => void chooseRepo(row.path)}
							>
								<div className="truncate">{row.name}</div>
								<div className="truncate font-mono text-[11px] text-zinc-500">{row.path}</div>
							</button>
							<button
								type="button"
								className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
								onClick={() => void dropRepo(row.path)}
								aria-label={`Remove ${row.name}`}
							>
								×
							</button>
						</li>
					))}
					<li>
						<button
							type="button"
							className={`w-full rounded px-3 py-2 text-left text-sm ${
								repo === UnlinkedRepo ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900"
							}`}
							onClick={() => void chooseRepo(UnlinkedRepo)}
						>
							<div>Unlinked</div>
							<div className="text-[11px] text-zinc-500">Sessions with no folder</div>
						</button>
					</li>
				</ul>
				<div className="flex items-center justify-between gap-2 border-y border-zinc-800 px-4 py-3">
					<span className="text-sm font-medium">Sessions</span>
					<button
						type="button"
						className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-40"
						disabled={!canCreate}
						onClick={() => void create()}
					>
						New
					</button>
				</div>
				<ul className="min-h-0 flex-1 overflow-y-auto p-2">
					{visible.map((session) => (
						<li key={session.id}>
							<button
								type="button"
								className={`w-full rounded px-3 py-2 text-left text-sm ${
									session.id === selected ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900"
								}`}
								onClick={() => setSelected(session.id)}
							>
								<div className="truncate">{session.title}</div>
								<div className="truncate font-mono text-[11px] text-zinc-500">{session.id}</div>
							</button>
						</li>
					))}
				</ul>
			</aside>
			<main className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
					<div className="flex items-center gap-2 text-sm">
						<span
							className={`h-2 w-2 rounded-full ${status.connected ? "bg-emerald-400" : "bg-red-400"}`}
							aria-hidden
						/>
						<span>{status.connected ? "Connected" : "Disconnected"}</span>
						<span className="font-mono text-xs text-zinc-500">{status.url}</span>
					</div>
					<button
						type="button"
						className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
						onClick={() =>
							void api()
								.connect()
								.then((result) => {
									if (result.ok) void refresh();
									else setStatus(disconnected(DefaultUrl, result.error));
								})
						}
					>
						Reconnect
					</button>
				</header>
				{!status.connected ? <p className="px-4 py-3 text-sm text-amber-200">{status.error}</p> : null}
				{error !== undefined ? <p className="px-4 py-2 text-sm text-red-300">{error}</p> : null}
				<div className="min-h-0 flex-1 overflow-auto">
					<Thread
						messages={selected === undefined ? [] : (threads[selected] ?? [])}
						empty={
							repo === UnlinkedRepo
								? "Sessions created without a folder land here."
								: selected === undefined
									? "Open a repository, then create a session."
									: "Send a message to start this session."
						}
					/>
				</div>
				<form
					className="border-t border-zinc-800 p-3"
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
						<textarea
							className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed outline-none"
							value={prompt}
							rows={1}
							placeholder={
								!status.connected
									? "Connect to codework serve first"
									: repo === UnlinkedRepo
										? "Open a repository to chat"
										: "Ask anything"
							}
							disabled={!canCreate || busy}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									void send();
								}
							}}
						/>
						<button
							type="submit"
							className="rounded-lg bg-zinc-100 px-3 py-1.5 text-sm text-zinc-950 disabled:opacity-40"
							disabled={!canCreate || busy || prompt.trim() === ""}
						>
							Send
						</button>
					</div>
				</form>
			</main>
		</div>
	);
};
