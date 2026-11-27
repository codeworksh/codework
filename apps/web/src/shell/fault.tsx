import { CaretRightIcon } from "@phosphor-icons/react";
import { type ErrorComponentProps, useNavigate, useRouter } from "@tanstack/react-router";
import { Component, type ReactNode, useEffect, useState } from "react";

import { CopyButton } from "@/components/copyable";
import { GLOW, onScreen, spritePath, TERMINAL_HEIGHT, TERMINAL_WIDTH } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { reveal } from "../splash";

const FOUR_O_FOUR = ["#.#.###.#.#", "#.#.#.#.#.#", "###.#.#.###", "..#.#.#...#", "..#.###...#"];
// A crossed-out prompt, then its cursor.
const CROSS = ["#.#......", ".#.......", "#.#..###."];

const NOT_FOUND_PATH = spritePath(onScreen(FOUR_O_FOUR, 2, 2));
const CRASHED_PATH = spritePath(onScreen(CROSS, 4, 3));
const GLOW_PATH = spritePath(GLOW);

function Art({ kind }: { readonly kind: "notfound" | "crashed" }) {
	return (
		<svg
			role="img"
			aria-label={kind === "notfound" ? "404" : "Crashed"}
			viewBox={`0 0 ${TERMINAL_WIDTH} ${TERMINAL_HEIGHT}`}
			shapeRendering="crispEdges"
			className="pointer-events-none w-28 shrink-0 text-ink-muted/45 select-none"
			fill="currentColor"
		>
			<path d={GLOW_PATH} opacity={0.35} />
			<path d={kind === "notfound" ? NOT_FOUND_PATH : CRASHED_PATH} />
		</svg>
	);
}

/** No page at this address: shown where the page would be. */
export function NotFound() {
	return (
		<div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
			<Art kind="notfound" />
			<h1 className="text-ui font-medium text-ink">Page Not Found</h1>
		</div>
	);
}

/** A page that threw: shown in its place, so the rest of the app keeps working. */
export function PageError({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const navigate = useNavigate();
	return (
		<Crashed title="Page Crashed" error={error}>
			<Button
				size="sm"
				onClick={() => {
					reset();
					void router.invalidate();
				}}
			>
				Try Again
			</Button>
			<Button size="sm" variant="ghost" onClick={() => void navigate({ to: "/" })}>
				Go Home
			</Button>
		</Crashed>
	);
}

/** The app itself threw: the whole window, with nothing of the app left to trust but a reload. */
export function AppError({ error }: { readonly error: unknown }) {
	// The boot splash only lifts once the app's own first page is up, which never happens after this.
	useEffect(reveal, []);
	return (
		<div className="fixed inset-0 flex flex-col bg-desktop text-ink">
			<div className="h-titlebar shrink-0 [-webkit-app-region:drag]" />
			<Crashed title="CodeWork Crashed" error={error}>
				<Button size="sm" onClick={() => window.location.reload()}>
					Reload
				</Button>
			</Crashed>
		</div>
	);
}

/** Catches what throws above the router (sign-in, providers) and shows {@link AppError}. */
export class CrashBoundary extends Component<
	{ readonly children: ReactNode },
	{ readonly crashed: boolean; readonly error: unknown }
> {
	override state = { crashed: false, error: undefined as unknown };
	static getDerivedStateFromError(error: unknown) {
		return { crashed: true, error };
	}
	override render() {
		return this.state.crashed ? <AppError error={this.state.error} /> : this.props.children;
	}
}

function Crashed({
	title,
	error,
	children,
}: {
	readonly title: string;
	readonly error: unknown;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const trace = traceOf(error);
	return (
		<div className="flex h-full min-h-0 flex-1 flex-col items-center overflow-y-auto p-6">
			<div className="my-auto flex w-full max-w-2xl flex-col items-center gap-4 py-10 text-center">
				<Art kind="crashed" />
				<div className="flex flex-col items-center gap-1.5">
					<h1 className="text-ui font-medium text-ink">{title}</h1>
					<p
						className="line-clamp-2 max-w-md text-xs break-words text-pretty text-ink-muted"
						title={trace.message}
					>
						{trace.message}
					</p>
				</div>
				<div className="flex items-center gap-2">{children}</div>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
					className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-ink-muted outline-none transition-colors duration-150 ease-out hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<CaretRightIcon size={10} aria-hidden className={open ? "rotate-90" : ""} />
					{open ? "Hide Details" : "Show Details"}
				</button>
				{open && (
					<div className="relative w-full rounded-lg border border-edge bg-desktop/60 text-left">
						<CopyButton value={reportOf(trace)} label="Copy Details" className="absolute top-1.5 right-1.5" />
						<div className="max-h-80 overflow-auto p-3 pr-10">
							<TraceLines trace={trace} />
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

interface Frame {
	readonly fn: string;
	readonly file: string;
	readonly line: string;
	readonly library: boolean;
}

interface Trace {
	readonly name: string;
	readonly message: string;
	readonly frames: ReadonlyArray<Frame>;
	readonly cause: Trace | undefined;
}

// V8's frame line: `    at fn (url:line:col)`, or without the name and parentheses.
const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

function traceOf(error: unknown): Trace {
	if (!(error instanceof Error)) return { name: "Error", message: messageOf(error), frames: [], cause: undefined };
	const frames = (error.stack ?? "").split("\n").flatMap((line) => {
		const match = FRAME.exec(line);
		if (match === null) return [];
		const [, fn = "<anonymous>", url = "", row = "", col = ""] = match;
		// The app's origin and Vite's cache-busting query say nothing about where the code is.
		const file = url
			.replace(/^[a-z-]+:\/\/[^/]+\//, "")
			.replace(/\?[^:]*$/, "")
			.replace(/^@fs\//, "/");
		return [{ fn, file, line: `${row}:${col}`, library: /node_modules|\.vite\/deps/.test(file) }];
	});
	return {
		name: error.name,
		message: error.message,
		frames,
		cause: error.cause === undefined ? undefined : traceOf(error.cause),
	};
}

function reportOf(trace: Trace): string {
	const body = (t: Trace): string =>
		[`${t.name}: ${t.message}`, ...t.frames.map((f) => `    at ${f.fn} (${f.file}:${f.line})`)].join("\n") +
		(t.cause === undefined ? "" : `\nCaused by: ${body(t.cause)}`);
	return [
		body(trace),
		"",
		`Route: ${window.location.hash || window.location.pathname}`,
		`Time: ${new Date().toISOString()}`,
		`Agent: ${navigator.userAgent}`,
	].join("\n");
}

function TraceLines({ trace }: { readonly trace: Trace }) {
	return (
		<div className="font-mono text-code leading-relaxed">
			<p className="break-words whitespace-pre-wrap text-destructive">
				<span className="font-medium">{trace.name}</span>: {trace.message}
			</p>
			<Frames frames={trace.frames} />
			{trace.cause !== undefined && (
				<div className="mt-2">
					<p className="break-words whitespace-pre-wrap text-ink-secondary">
						<span className="text-ink-muted">Caused by </span>
						<span className="font-medium">{trace.cause.name}</span>: {trace.cause.message}
					</p>
					<Frames frames={trace.cause.frames} />
				</div>
			)}
		</div>
	);
}

/** Frames in order, each run of library frames folded into one row that opens in place. */
function Frames({ frames }: { readonly frames: ReadonlyArray<Frame> }) {
	const runs: Array<{ library: boolean; frames: Frame[] }> = [];
	for (const frame of frames) {
		const last = runs.at(-1);
		if (last?.library === frame.library) last.frames.push(frame);
		else runs.push({ library: frame.library, frames: [frame] });
	}
	return (
		<ol className="mt-1">
			{runs.map((run, i) =>
				run.library ? (
					<Folded key={i} frames={run.frames} />
				) : (
					run.frames.map((frame, j) => <FrameRow key={`${i}-${j}`} frame={frame} />)
				),
			)}
		</ol>
	);
}

function Folded({ frames }: { readonly frames: ReadonlyArray<Frame> }) {
	const [open, setOpen] = useState(false);
	if (open) return frames.map((frame, i) => <FrameRow key={i} frame={frame} />);
	return (
		<li className="pl-4">
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-sm text-ink-muted/60 outline-none hover:text-ink-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				… {frames.length} library {frames.length === 1 ? "frame" : "frames"}
			</button>
		</li>
	);
}

function FrameRow({ frame }: { readonly frame: Frame }) {
	return (
		<li className="flex min-w-0 gap-2 pl-4 whitespace-nowrap">
			<span className="text-ink-muted/60">at</span>
			<span className="shrink-0 text-ink">{frame.fn}</span>
			<span className="min-w-0 truncate text-ink-muted" title={`${frame.file}:${frame.line}`}>
				{frame.file}
				<span className="text-ink-muted/60 tabular-nums">:{frame.line}</span>
			</span>
		</li>
	);
}
