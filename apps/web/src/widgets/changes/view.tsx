import {
	type ChangedFile,
	ChangesError,
	type ChangesSpace,
	type SpaceChanges,
	type SpaceDiff,
} from "@codeworksh/contract";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { useFrame, type WidgetProps } from "@codeworksh/widget/view";
import { Option, Result } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowsInLineVerticalIcon,
	ArrowsOutLineVerticalIcon,
	CaretRightIcon,
	ColumnsIcon,
	GitDiffIcon,
	RowsIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import {
	type ComponentProps,
	forwardRef,
	type KeyboardEvent,
	type MouseEvent,
	memo,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNowMinute } from "@/hooks/now";
import { ago } from "../time";
import { changesRef } from "./address";
import { diffAtom, fileAtom, hiddenAtom, type Patches, spaceAtom, statusAtom } from "./data";
import { Diff, DiffPool, type DiffStyle, diffStyleAtom, LINE } from "./diff";
import { inView, shown, slide, topOf } from "./fold";
import { recall, remember } from "./memory";
import { Space } from "./space";

// A frame draws its icon with stroke props, which a filled icon does not take.
export const ChangesIcon = forwardRef<SVGSVGElement, ComponentProps<"svg">>(({ className }, ref) => (
	<GitDiffIcon ref={ref} className={className} aria-hidden />
));

export function Changes({ address, instanceId }: WidgetProps<unknown>) {
	const ref = changesRef(address);
	if (ref === undefined) return <p className="p-3 text-ink-muted">Not a space: {address}</p>;
	// Another space starts over: its own file, its own position.
	return <Review key={address} instanceId={instanceId} space={`${ref.machineId}/${ref.spaceId}`} />;
}

const unavailable: Record<NonNullable<SpaceChanges["reason"]>, string> = {
	"not-a-repository": "Not a Git Repository",
	"git-missing": "Git Is Not Installed",
	failed: "Git Failed",
};

/** How long the skeleton takes to leave, in milliseconds, as its classes say. */
const LEAVE = 200;

function Review({ space, instanceId }: { readonly space: string; readonly instanceId: string }) {
	const root = useRef<HTMLDivElement>(null);
	const status = Option.getOrUndefined(AsyncResult.value(useAtomValue(statusAtom(space))));
	const where = Option.getOrNull(AsyncResult.value(useAtomValue(spaceAtom(space))));
	const running = where?.threads.some((thread) => thread.runState !== "idle") === true;
	const { loaded, retry } = useDiff(space, useShown(root), running);
	const patches = Option.getOrUndefined(AsyncResult.value(loaded));
	const listed = status?.available === true && status.files.length > 0;
	// An untracked folder is one entry until the patches name its files: listed before them, its row
	// would turn into theirs under the reader's eyes.
	const known = status !== undefined && !(listed && patches === undefined && status.files.some(folderOf));
	const { setTitle } = useFrame();
	// With changes, the list titles the frame: its folders open into their files. Not while unknown:
	// a frame coming back would name itself twice.
	useEffect(() => {
		if (known && !listed) setTitle("Git Changes");
	}, [known, listed, setTitle]);
	// Nothing was known of the space when this opened: its shape stands in, and what is read fades in
	// over it. A space read before shows at once, as it is.
	const [cold] = useState(!known);
	const [left, setLeft] = useState(false);
	useEffect(() => {
		if (!cold || !known) return;
		const timer = setTimeout(() => setLeft(true), LEAVE);
		return () => clearTimeout(timer);
	}, [cold, known]);
	const body = !known ? null : status == null ? (
		<Message>Not Synced Yet</Message>
	) : !status.available ? (
		<Message detail={status.message}>{unavailable[status.reason ?? "failed"]}</Message>
	) : status.files.length === 0 ? (
		<Message>No Changes</Message>
	) : (
		<Files space={space} instanceId={instanceId} status={status} loaded={loaded} retry={retry} where={where} />
	);
	return (
		<div ref={root} className="relative h-full">
			{!cold ? body : known && <div className="h-full animate-in duration-200 ease-out fade-in">{body}</div>}
			{cold && !left && <Skeleton leaving={known} />}
		</div>
	);
}

/** Whether the element is on screen: a frame stays mounted, hidden, while overflowed or collapsed. */
function useShown(ref: RefObject<HTMLElement | null>) {
	const [shown, setShown] = useState(true);
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const observer = new IntersectionObserver((entries) => setShown(entries.at(-1)?.isIntersecting === true));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return shown;
}

/**
 * A space's patches, read only while its frame is shown; hidden, it keeps what it last showed. A
 * failed read is tried again each time the frame is shown, and when a run there starts or ends.
 */
function useDiff(space: string, visible: boolean, running: boolean) {
	const atom = diffAtom(space);
	const live = useAtomValue(visible ? atom : hiddenAtom);
	const [last, setLast] = useState(live);
	if (visible && live !== last) setLast(live);
	const registry = useContext(RegistryContext);
	useEffect(() => {
		if (visible && failed(registry.get(atom))) registry.refresh(atom);
	}, [visible, running, atom, registry]);
	return { loaded: visible ? live : last, retry: () => registry.refresh(atom) };
}

const failed = (loaded: Patches) =>
	!loaded.waiting &&
	(AsyncResult.isFailure(loaded) ||
		(AsyncResult.isSuccess(loaded) && loaded.value !== undefined && Result.isFailure(loaded.value)));

const bars = [38, 52, 30, 46, 34, 58, 42];

/**
 * The list's shape, at its sizes, while nothing is known of it. It shows late and slowly, so a quick
 * read never flashes it, and leaves from however far it got.
 */
function Skeleton({ leaving }: { readonly leaving: boolean }) {
	return (
		<div
			aria-hidden
			data-skeleton
			className={`pointer-events-none absolute inset-0 flex flex-col overflow-hidden bg-frame transition-opacity ease-out ${
				leaving ? "opacity-0 duration-200" : "opacity-100 delay-300 duration-[450ms] starting:opacity-0"
			}`}
		>
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-edge px-3">
				<Bar className="w-20" />
				<Bar className="w-16" />
				<Bar className="ml-auto w-20" />
			</div>
			<div className="flex h-7 shrink-0 items-center gap-3 border-b border-edge px-3">
				<Bar className="w-24" />
				<Bar className="w-16" />
			</div>
			{bars.map((width) => (
				<div key={width} className="flex h-[33px] shrink-0 items-center gap-2 border-b border-edge px-3">
					<Bar className="w-3.5" />
					<Bar style={{ width: `${width}%` }} />
					<Bar className="ml-auto w-10" />
				</div>
			))}
		</div>
	);
}

function Bar({ className = "", style }: { readonly className?: string; readonly style?: { readonly width: string } }) {
	return <span style={style} className={`h-2.5 shrink-0 rounded-sm bg-ink/8 ${className}`} />;
}

function Files(props: {
	readonly space: string;
	readonly instanceId: string;
	readonly status: SpaceChanges;
	readonly loaded: Patches;
	readonly retry: () => void;
	readonly where: ChangesSpace | null;
}) {
	const { space, instanceId, status, loaded } = props;
	const result = Option.getOrUndefined(AsyncResult.value(loaded));
	const diff = result !== undefined && Result.isSuccess(result) ? result.success : undefined;
	const failure =
		result !== undefined && Result.isFailure(result) ? failureOf(result.failure, props.where) : undefined;
	const files = expand(status.files, diff);
	const patches = new Map(diff?.files.map((entry) => [entry.file, entry.patch]));
	// Why an unfolded file shows no patch. A file that just changed may be in the patches being read.
	const absent =
		failure !== undefined
			? failure.title
			: diff === undefined || loaded.waiting
				? undefined
				: diff.truncated === true
					? "Left Out of the Diff"
					: "No Diff";
	const { setTitle } = useFrame();
	useEffect(() => setTitle(`Files Changed ${files.length}`), [files.length, setTitle]);
	// As this copy last showed the space, while it was off the screen with its workspace.
	const [before] = useState(() => recall(instanceId, space));
	// Both kept by path, so a refresh that reorders the list keeps the same file current and unfolded.
	// Folded unless unfolded: hundreds of files open as a list to pick from, and a new file joins it folded.
	const [selected, setSelected] = useState(before.selected);
	const [opened, setOpened] = useState(before.opened);
	useEffect(() => remember(instanceId, space, { opened, selected }), [instanceId, space, opened, selected]);
	const [listed, setListed] = useState(false);
	const [style, setStyle] = useAtom(diffStyleAtom);
	const scroller = useRef<HTMLDivElement>(null);
	const index = Math.max(
		0,
		files.findIndex((file) => file.file === selected),
	);
	const allFolded = !files.some((file) => opened.has(file.file));
	// Before the first paint, where the list was: the file at its top, as far into it.
	useLayoutEffect(() => {
		const list = scroller.current;
		const anchor = before.anchor;
		if (list === null || anchor === undefined) return;
		const section = Array.from(list.children).find(
			(child) => child instanceof HTMLElement && child.dataset.file === anchor.file,
		);
		if (section instanceof HTMLElement) list.scrollTop = section.offsetTop + anchor.offset;
	}, [before]);
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
	const reveal = (at: number) => {
		const list = scroller.current;
		const section = list?.children[at];
		if (list !== null && section instanceof HTMLElement) list.scrollTop = section.offsetTop;
	};
	const go = (at: number) => {
		const path = files[at]?.file;
		if (path === undefined) return;
		// Scrolled to first, where its header already is: it then unfolds in view, with its diff. Again
		// after, for a file the list was too short to bring to the top while folded.
		reveal(at);
		flushSync(() => {
			setSelected(path);
			setOpened((set) => (set.has(path) ? set : new Set([...set, path])));
		});
		reveal(at);
	};
	// One handler on the list rather than one per file: a file then takes plain values alone, and renders
	// only when they change. Flushed between measuring and sliding, so the slide starts from what
	// showed and ends on the new layout.
	const toggle = (event: MouseEvent<HTMLDivElement>) => {
		const list = event.currentTarget;
		const header = event.target instanceof Element ? event.target.closest("button[aria-expanded]") : null;
		const section = header?.parentElement;
		const path = section?.dataset.file;
		if (header == null || section == null || path === undefined || section.parentElement !== list) return;
		const fold = header.getAttribute("aria-expanded") === "true";
		const was = shown(list, section);
		flushSync(() => setOpened((set) => new Set(fold ? [...set].filter((other) => other !== path) : [...set, path])));
		slide(section, fold ? was : shown(list, section), fold ? "shut" : "open");
		// Folded from its sticky header, the file would otherwise leave the view on the files below it.
		if (fold && section.offsetTop < list.scrollTop) list.scrollTop = section.offsetTop;
	};
	/** Folds or unfolds every file, keeping the top one at the top. */
	const toggleAll = () => {
		const list = scroller.current;
		const top = list?.children[list === null ? 0 : topOf(list)];
		if (list === null || !(top instanceof HTMLElement)) return;
		const fold = !allFolded;
		const parts = (sections: ReadonlyArray<HTMLElement>) =>
			sections.map((section) => [section, shown(list, section)] as const);
		const was = parts(inView(list));
		flushSync(() => setOpened(fold ? new Set() : new Set(files.map((file) => file.file))));
		if (!fold) list.scrollTop = top.offsetTop;
		for (const [section, part] of fold ? was : parts(inView(list))) slide(section, part, fold ? "shut" : "open");
		if (fold) list.scrollTop = top.offsetTop;
	};
	const step = (by: number) => go((index + by + files.length) % files.length);
	const onScroll = () => {
		const list = scroller.current;
		if (list === null) return;
		const top = topOf(list);
		// At the end, the files below the top one cannot reach the top: the one navigated to stays current.
		const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
		setSelected((path) => (atEnd && files.findIndex((file) => file.file === path) >= top ? path : files[top]?.file));
		const first = list.children[top];
		if (first instanceof HTMLElement && first.dataset.file !== undefined)
			remember(instanceId, space, {
				anchor: { file: first.dataset.file, offset: list.scrollTop - first.offsetTop },
				visible: new Set(inView(list).flatMap((section) => section.dataset.file ?? [])),
			});
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		const target = event.target;
		// The file list's popover is portalled out, and its keys are its own.
		if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return;
		if (target.isContentEditable || target.closest("input, textarea, select") !== null) return;
		event.preventDefault();
		step(event.key === "ArrowLeft" ? -1 : 1);
	};
	return (
		<div tabIndex={-1} onKeyDown={onKeyDown} className="@container flex h-full flex-col outline-none">
			<div className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b border-edge px-3 text-xs">
				<span className="min-w-0 truncate font-medium text-ink">Git Changes</span>
				<Counts additions={additions} deletions={deletions} />
				<div className="flex shrink-0 items-center">
					<IconButton label="Previous File" disabled={files.length < 2} onClick={() => step(-1)}>
						<ArrowLeftIcon className="size-3.5" aria-hidden />
					</IconButton>
					<Popover open={listed} onOpenChange={setListed}>
						<PopoverTrigger
							aria-label="Changed Files"
							// As wide as its last file, so the arrow after it stays put.
							style={{ minWidth: `calc(${String(files.length).length * 2 + 1}ch + 0.75rem)` }}
							className="h-6 rounded-md px-1.5 font-mono text-[11px] text-ink-secondary tabular-nums outline-none transition-colors duration-150 ease-out hover:bg-ink/8 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-ink/8 data-[state=open]:text-ink"
						>
							{index + 1}/{files.length}
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="max-h-80 w-80 overflow-y-auto p-1"
							onMouseDown={(event) => event.stopPropagation()}
						>
							{files.map((file, at) => (
								<button
									key={file.file}
									type="button"
									aria-current={at === index}
									onClick={() => {
										setListed(false);
										go(at);
									}}
									className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-xs outline-none hover:bg-ink/6 focus-visible:bg-ink/6 aria-current:bg-selection"
								>
									<Path file={file.file} status={file.status} />
								</button>
							))}
						</PopoverContent>
					</Popover>
					<IconButton label="Next File" disabled={files.length < 2} onClick={() => step(1)}>
						<ArrowRightIcon className="size-3.5" aria-hidden />
					</IconButton>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					<IconButton label={allFolded ? "Unfold All Files" : "Fold All Files"} onClick={toggleAll}>
						{allFolded ? (
							<ArrowsOutLineVerticalIcon className="size-3.5" aria-hidden />
						) : (
							<ArrowsInLineVerticalIcon className="size-3.5" aria-hidden />
						)}
					</IconButton>
					<IconButton label="Inline" pressed={style === "unified"} onClick={() => setStyle("unified")}>
						<RowsIcon className="size-3.5" aria-hidden />
					</IconButton>
					<IconButton label="Split" pressed={style === "split"} onClick={() => setStyle("split")}>
						<ColumnsIcon className="size-3.5" aria-hidden />
					</IconButton>
				</div>
			</div>
			<Space space={space} status={status} />
			<Problem failure={failure} retrying={loaded.waiting} onRetry={props.retry} />
			<DiffPool scroller={scroller}>
				<div ref={scroller} onScroll={onScroll} onClick={toggle} className="relative min-h-0 flex-1 overflow-auto">
					{files.map((file) => (
						<Entry
							key={file.file}
							space={space}
							file={file.file}
							status={file.status}
							additions={file.additions}
							deletions={file.deletions}
							folded={!opened.has(file.file)}
							eager={before.visible.has(file.file)}
							patch={patches.get(file.file)}
							absent={absent}
							style={style}
						/>
					))}
				</div>
				{diff !== undefined && <Notes diff={diff} observedAt={status.observedAt} />}
			</DiffPool>
		</div>
	);
}

/** A wholly untracked folder is one entry, with no patch. */
const isFolder = (file: string) => file.endsWith("/");
const folderOf = (file: ChangedFile) => isFolder(file.file);

/** The status lists a wholly untracked folder as one entry; once the patches are read, its files take its place. */
const expand = (files: ReadonlyArray<ChangedFile>, diff: SpaceDiff | undefined): ReadonlyArray<ChangedFile> =>
	diff === undefined
		? files
		: files.flatMap((entry) => {
				if (!isFolder(entry.file)) return [entry];
				const inside = diff.files.filter((file) => file.file.startsWith(entry.file));
				return inside.length === 0
					? [entry]
					: inside.map(({ file, status, additions, deletions }) => ({ file, status, additions, deletions }));
			});

/**
 * One file: its header and, under it, its diff. Memoized on plain values, so folding a file or scrolling
 * past one renders that file alone; the list handles its header's click. A diff once drawn stays
 * mounted while folded: unfolding shows it as it was.
 */
const Entry = memo(function Entry(props: {
	readonly space: string;
	readonly file: string;
	readonly status: ChangedFile["status"];
	readonly additions: number;
	readonly deletions: number;
	readonly folded: boolean;
	/** In view when its frame last left the screen: its diff is drawn with the first frame. */
	readonly eager: boolean;
	readonly patch: string | undefined;
	readonly absent: string | undefined;
	readonly style: DiffStyle;
}) {
	const folder = isFolder(props.file);
	const rows = useMemo(() => props.patch?.split("\n").length ?? 1, [props.patch]);
	const section = useRef<HTMLElement>(null);
	// A diff is drawn once its file is unfolded near the view, and kept from then on: folded files, and
	// the unfolded ones never reached, cost a header each. Checked before paint, so a file unfolded in
	// view opens with its diff and can slide; one scrolled to is seen coming, a view's height ahead.
	const [near, setNear] = useState(props.eager && !props.folded);
	const [drawn, setDrawn] = useState(near);
	if (near && !drawn) setDrawn(true);
	useLayoutEffect(() => {
		const own = section.current;
		const list = own?.parentElement;
		if (props.folded || own == null || list == null) return;
		const view = list.getBoundingClientRect();
		const box = own.getBoundingClientRect();
		setNear(box.top < view.bottom + view.height && box.bottom > view.top - view.height);
		const observer = new IntersectionObserver((entries) => setNear(entries.at(-1)?.isIntersecting === true), {
			root: list,
			rootMargin: "100% 0px",
		});
		observer.observe(own);
		return () => observer.disconnect();
	}, [props.folded]);
	return (
		<section ref={section} data-file={props.file} className="border-b border-edge">
			<button
				type="button"
				aria-expanded={!props.folded}
				className="group sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-edge bg-frame px-3 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-expanded:border-b"
			>
				<CaretRightIcon
					className="size-3.5 shrink-0 text-ink-muted transition-[rotate,color] duration-150 ease-out group-hover:text-ink group-aria-expanded:rotate-90"
					aria-hidden
				/>
				<Path file={props.file} status={props.status} />
				{!folder && <Counts additions={props.additions} deletions={props.deletions} />}
			</button>
			{/* Folded or far from view, a diff is skipped, standing at its last height or this one: the
			    pointer and every layout would otherwise go through each diff in the list, hundreds of files
			    deep. Skipped by hand, far ahead of the view: left to the browser, a diff coming into view, or
			    back with its frame, stands empty at a guessed height for a frame. */}
			<div className={props.folded ? "invisible h-0 overflow-hidden" : "overflow-hidden"}>
				<div
					style={{ containIntrinsicBlockSize: `auto ${rows * LINE}px` }}
					className={props.folded || !near ? "[content-visibility:hidden]" : undefined}
				>
					{folder ? (
						<Note>Untracked Folder</Note>
					) : props.patch === "" ? (
						drawn && (
							<Alone
								space={props.space}
								file={props.file}
								additions={props.additions}
								deletions={props.deletions}
								style={props.style}
							/>
						)
					) : props.patch !== undefined ? (
						drawn && <Diff patch={props.patch} style={props.style} />
					) : (
						props.absent !== undefined && <Note>{props.absent}</Note>
					)}
				</div>
			</div>
		</section>
	);
});

/**
 * A file left out of the patches for their size, read alone once it is unfolded. Shown only as the
 * list has it: a read whose counts differ is of a file changed since.
 */
function Alone(props: {
	readonly space: string;
	readonly file: string;
	readonly additions: number;
	readonly deletions: number;
	readonly style: DiffStyle;
}) {
	const loaded = useAtomValue(fileAtom(JSON.stringify([props.space, props.file, props.additions, props.deletions])));
	const result = Option.getOrUndefined(AsyncResult.value(loaded));
	if (result === undefined || loaded.waiting) return <Note>Loading…</Note>;
	if (Result.isFailure(result)) return <Note>{failureOf(result.failure, null).title}</Note>;
	const { entry, cached } = result.success;
	if (entry === undefined) return <Note>No Diff</Note>;
	if (entry.patch === "") return <Note>{cached ? "Left Out of the Last Run’s Diff" : "Too Large to Show"}</Note>;
	if (entry.additions !== props.additions || entry.deletions !== props.deletions)
		return <Note>Changed Since It Was Listed</Note>;
	return <Diff patch={entry.patch} style={props.style} />;
}

/** Why the patches could not be read. */
const failureOf = (
	error: { readonly _tag: string },
	where: ChangesSpace | null,
): { readonly title: string; readonly detail?: string } => {
	if (!(error instanceof ChangesError)) return { title: "The CodeWork Server Is Not Reachable" };
	if (error.reason === "failed") return { title: "Git Failed", detail: error.message };
	if (error.reason === "detached" && where?.env?.status === "offline") return { title: "The Sandbox Is Stopped" };
	return { title: "Diffs Appear During the Next Run" };
};

/**
 * Why the patches are not there, in a row under the space that opens when they fail and closes when
 * they are back. The files stay listed from the status. Already failed on open, it is there at once.
 */
function Problem(props: {
	readonly failure: ReturnType<typeof failureOf> | undefined;
	readonly retrying: boolean;
	readonly onRetry: () => void;
}) {
	// Kept while it closes, so the row leaves showing what it said.
	const [last, setLast] = useState(props.failure);
	if (props.failure !== undefined && (props.failure.title !== last?.title || props.failure.detail !== last.detail))
		setLast(props.failure);
	const open = props.failure !== undefined;
	return (
		<div
			aria-hidden={!open}
			inert={!open}
			className={`shrink-0 overflow-hidden transition-[height,opacity] duration-200 ease-out motion-reduce:transition-none ${
				open ? "h-7 opacity-100" : "h-0 opacity-0"
			}`}
		>
			{last !== undefined && (
				<div
					role="status"
					title={last.detail}
					className="flex h-7 items-center gap-1.5 border-b border-edge bg-warning/8 px-3 text-2xs whitespace-nowrap text-warning"
				>
					<WarningCircleIcon className="size-3 shrink-0" weight="bold" aria-hidden />
					<span className="shrink-0 font-medium">Diffs Unavailable</span>
					<span aria-hidden>·</span>
					<span className="min-w-0 truncate">{last.title}</span>
					<span aria-hidden>·</span>
					{props.retrying ? (
						<span className="shrink-0">Retrying…</span>
					) : (
						<button
							type="button"
							onClick={props.onRetry}
							className="relative shrink-0 rounded-sm font-medium underline-offset-2 outline-none before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-[''] hover:underline focus-visible:ring-2 focus-visible:ring-ring"
						>
							Retry
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** What the patches shown are, when they are not plainly the latest of every file. */
function Notes({ diff, observedAt }: { readonly diff: SpaceDiff; readonly observedAt: number }) {
	const span = ago(observedAt, useNowMinute());
	const notes = [
		...(diff.cached === true ? [`From the Last Run, ${span === "now" ? "Just Now" : `${span} Ago`}`] : []),
		...(diff.truncated === true ? ["Some Files Are Left Out"] : []),
	];
	if (notes.length === 0) return null;
	return (
		// Below the list: it arrives with the patches, after the files, and above them would push them down.
		<div className="shrink-0 truncate border-t border-edge px-3 py-1.5 text-2xs text-ink-muted">
			{notes.join(" · ")}
		</div>
	);
}

/** Said by letter too, not by colour alone. */
const letter: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D" };

const statusColor: Record<ChangedFile["status"], string> = {
	added: "text-success",
	modified: "text-warning",
	deleted: "text-destructive",
};

/**
 * The file's name in its status colour, then its folder, cut from its start when narrow: the nearest
 * folders tell files apart.
 */
function Path({ file, status }: { readonly file: string; readonly status: ChangedFile["status"] }) {
	const trimmed = file.endsWith("/") ? file.slice(0, -1) : file;
	const cut = trimmed.lastIndexOf("/");
	const name = `${trimmed.slice(cut + 1)}${file.endsWith("/") ? "/" : ""}`;
	const directory = cut < 0 ? "" : trimmed.slice(0, cut);
	return (
		<span title={file} className="flex min-w-0 flex-1 items-baseline gap-1.5">
			<span
				aria-hidden
				className={`w-2 shrink-0 text-center font-mono text-[10px] font-medium ${statusColor[status]}`}
			>
				{letter[status]}
			</span>
			<span className={`shrink-0 font-medium ${statusColor[status]}`}>{name}</span>
			<span className="sr-only">{status}</span>
			{directory !== "" && (
				// The embedding marks keep the path reading left to right inside the right-to-left cut.
				<span className="min-w-0 truncate text-left text-ink-muted [direction:rtl]">{`‪${directory}/‬`}</span>
			)}
		</span>
	);
}

function Counts({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
	return (
		<span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
			<span className="text-success">+{additions}</span>
			<span className="text-destructive">−{deletions}</span>
		</span>
	);
}

function IconButton(props: {
	readonly label: string;
	readonly disabled?: boolean;
	readonly pressed?: boolean;
	readonly onClick: () => void;
	readonly children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={props.label}
			aria-pressed={props.pressed}
			title={props.label}
			disabled={props.disabled}
			onClick={props.onClick}
			className="relative grid size-6 place-items-center rounded-md before:absolute before:-inset-y-1.5 before:content-[''] text-ink-muted outline-none transition-[background-color,color] duration-150 ease-out hover:bg-ink/8 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-ink/8 aria-pressed:text-ink"
		>
			{props.children}
		</button>
	);
}

/** What the widget shows in place of changes: the fact, and git's own words below it. */
function Message({ children, detail }: { readonly children: ReactNode; readonly detail?: string | undefined }) {
	return (
		<div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-xs">
			<p className="text-ink-secondary">{children}</p>
			{detail !== undefined && <p className="max-w-md wrap-break-word text-ink-muted">{detail}</p>}
		</div>
	);
}

function Note({ children }: { readonly children: ReactNode }) {
	return <p className="px-4 py-3 text-xs text-ink-muted">{children}</p>;
}
