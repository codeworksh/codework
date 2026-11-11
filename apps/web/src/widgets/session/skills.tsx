import type { SpaceSkills } from "@codeworksh/contract";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useId, useState } from "react";

import { ChevronDown } from "@/components/vuesax";
import { Server } from "../../kernel/rpc";
import { useElementSize } from "../../wm/size";
import { useNowMinute } from "@/hooks/now";
import { ago } from "../time";
import { Row, Section, Tag, useTilde } from "./config";

const skillsOf = (machineId: string, projectId: string) => Server.query("projects.skills", { machineId, projectId });

/** A checkout's role, as its group says it; a folder that is not a repository needs none. */
const roles: Record<SpaceSkills["space"]["kind"], string | undefined> = {
	primary: "main",
	linked: "worktree",
	copy: "copy",
	plain: undefined,
};

/** How many spaces, and skills in each, show before the rest fold behind a button. */
const SPACES = 3;
const SKILLS = 5;

/**
 * The first `limit` of `items` until opened, and how many are folded away. One more is shorter than
 * the button that would hide it, so only a longer list folds.
 */
const foldOf = <A,>(items: ReadonlyArray<A>, limit: number, open: boolean) => {
	const folded = items.length > limit + 1 ? items.length - limit : 0;
	return { folded, shown: folded > 0 && !open ? items.slice(0, limit) : items };
};

/** A sandbox by the provider's own id, or by ours until the provider has named it. */
const sandboxIdOf = ({ space, sandbox }: SpaceSkills) => sandbox?.providerResourceId ?? space.env ?? "";

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The skills sessions in this project see, one group per space: read-only, since a skill is a file
 * people write. Host checkouts are read each time; a sandbox shows its last read while it is stopped.
 */
export function Skills({ machineId, projectId }: { readonly machineId: string; readonly projectId: string }) {
	const result = useAtomValue(skillsOf(machineId, projectId));
	const [open, setOpen] = useState(false);
	if (AsyncResult.isFailure(result)) return null;
	// A memory sandbox keeps nothing, so there is nothing to show for it.
	const spaces = AsyncResult.isSuccess(result)
		? result.value.filter(({ sandbox }) => sandbox?.driver !== "memory")
		: undefined;
	if (spaces?.length === 0) return null;
	// The main checkout comes first, so it always shows.
	const { folded, shown } = foldOf(spaces ?? [], SPACES, open);
	return (
		<Section title="Skills">
			<Grow>
				{spaces === undefined ? (
					<Placeholder />
				) : (
					shown.map((space) => <SpaceGroup key={space.space.id} entry={space} />)
				)}
				{folded > 0 && (
					<Fold section open={open} onToggle={() => setOpen(!open)}>
						{open ? "Show Fewer Spaces" : `Show ${folded} More Spaces`}
					</Fold>
				)}
			</Grow>
		</Section>
	);
}

/**
 * Eases to the height of what it holds. The placeholder is shorter than any list, so the section only
 * ever grows into place: the page below moves down once, smoothly, instead of jumping or shrinking back.
 */
function Grow({ children }: { readonly children: ReactNode }) {
	const [ref, size] = useElementSize<HTMLDivElement>();
	return (
		<div
			// Until it is measured the height is left to the content, so the first frame never animates.
			style={size.height === 0 ? undefined : { height: size.height }}
			className="overflow-hidden transition-[height] duration-300 ease-(--ease-out) motion-reduce:transition-none"
		>
			<div ref={ref} className="flex flex-col divide-y divide-edge/60">
				{children}
			</div>
		</div>
	);
}

/** A header and one row: less than the list it stands for, so the list only grows from it. */
function Placeholder() {
	const bar = "rounded-sm bg-ink/6 motion-safe:animate-pulse";
	return (
		<div aria-busy="true" aria-label="Loading skills" className="flex flex-col divide-y divide-edge/60">
			<div className="flex flex-col gap-1.5 bg-ink/2 px-4 py-2.5">
				<span className={`h-3 w-24 ${bar}`} />
				<span className={`h-2.5 w-64 max-w-full ${bar}`} />
			</div>
			<div className="flex min-h-15 flex-col justify-center gap-1.5 px-4 py-3">
				<span className={`h-3.5 w-32 ${bar}`} />
				<span className={`h-3 w-1/2 ${bar}`} />
			</div>
		</div>
	);
}

function SpaceGroup({ entry }: { readonly entry: SpaceSkills }) {
	const id = useId();
	const shorten = useTilde();
	const remote = entry.sandbox !== null;
	const role = remote ? undefined : roles[entry.space.kind];
	const path = remote ? entry.space.location : shorten(entry.space.location);
	const skills = entry.skills ?? [];
	const [open, setOpen] = useState(false);
	const { folded, shown } = foldOf(skills, SKILLS, open);
	return (
		<div
			role="group"
			aria-labelledby={id}
			className="flex flex-col divide-y divide-edge/60 transition-opacity duration-200 ease-out starting:opacity-0"
		>
			{/* Where the space is, then its folder; a sandbox says when it was last read. */}
			<div className="flex flex-col gap-0.5 bg-ink/2 px-4 py-2 text-xs text-ink-muted">
				<div className="flex min-w-0 items-center gap-2">
					<span id={id} className="shrink-0 text-ink-secondary">
						{remote ? capitalized(entry.sandbox?.driver ?? "") : "Local"}
					</span>
					{role !== undefined && <Tag>{role}</Tag>}
					{remote && (
						<span title={sandboxIdOf(entry)} className="min-w-0 truncate font-mono text-[11px]">
							{sandboxIdOf(entry)}
						</span>
					)}
					{remote && (
						<span className="ml-auto shrink-0 pl-2 lowercase">
							{entry.syncedAt === null ? "not synced yet" : <Synced time={entry.syncedAt} />}
						</span>
					)}
				</div>
				{/* Cut from its start: the last parts tell spaces apart. */}
				<span
					title={entry.space.location}
					className="min-w-0 truncate text-left font-mono text-[11px] text-ink-muted/80 [direction:rtl]"
				>
					<bdi>{path}</bdi>
				</span>
			</div>
			{shown.map((skill) => (
				<Row
					key={skill.name}
					// One the model is never offered reads quieter: present, but only for people to open.
					title={<span className={`truncate ${skill.hidden ? "text-ink-muted" : ""}`}>{skill.name}</span>}
					description={skill.description}
				/>
			))}
			{folded > 0 && (
				<Fold open={open} onToggle={() => setOpen(!open)}>
					{open ? "Show Less" : `Show ${folded} More`}
				</Fold>
			)}
			{entry.skills !== null && skills.length === 0 && (
				<div className="flex h-10 items-center px-4 text-xs text-ink-muted">No Skills Configured</div>
			)}
		</div>
	);
}

/** The row that opens what a list folds away, and folds it again. */
function Fold(props: {
	readonly open: boolean;
	readonly onToggle: () => void;
	/** Folds whole spaces: tinted like their headers, so it reads as the section's, not the last group's. */
	readonly section?: boolean;
	readonly children: string;
}) {
	return (
		<button
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
			className={`flex h-10 w-full items-center gap-1.5 px-4 text-left text-xs text-ink-muted outline-none transition-[background-color,color] duration-150 ease-out hover:bg-ink/4 hover:text-ink focus-visible:bg-ink/4 focus-visible:text-ink ${props.section === true ? "bg-ink/2" : ""}`}
		>
			<ChevronDown
				className={`size-3.5 transition-transform duration-200 ease-(--ease-out) ${props.open ? "rotate-180" : ""}`}
				aria-hidden
			/>
			{props.children}
		</button>
	);
}

function Synced({ time }: { readonly time: number }) {
	const span = ago(time, useNowMinute());
	return span === "now" ? "synced just now" : `synced ${span} ago`;
}
