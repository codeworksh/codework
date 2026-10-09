import { useAtom, useAtomSet } from "@effect/atom-react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isMac } from "../kernel/platform";
import { iconOf, icons } from "../shell/icons";
import { shortcutLabel } from "../shell/switcher";
import { deskAtom, only, untag } from "../wm/instances";
import {
	createWorkspace,
	deleteWorkspace,
	reorderWorkspaces,
	updateWorkspace,
	useWorkspaces,
	type Workspace,
	workspacesKey,
	workspaceTag,
} from "../wm/workspaces";
import { Group, Keys, Page, Row, Section } from "./blocks";

// webwm tag bits available, and so the Cmd+1–9 keys; the server enforces it too.
const MAX = 9;

const sameOrder = (ids: readonly string[], workspaces: readonly Workspace[]) =>
	ids.length === workspaces.length && ids.every((id, index) => workspaces[index]?.id === id);

/** List, create, rename, re-icon, reorder (drag the grip), and delete workspaces. */
export function WorkspacesSettings() {
	const workspaces = useWorkspaces();
	const create = useAtomSet(createWorkspace, { mode: "promise" });
	const reorder = useAtomSet(reorderWorkspaces, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	// The new workspace, whose name field takes focus.
	const [created, setCreated] = useState<string | null>(null);
	// Order while dragging and until the server's list catches up with it.
	const [order, setOrder] = useState<readonly string[] | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	if (order !== null && dragging === null && sameOrder(order, workspaces)) setOrder(null);

	const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	const listed = order === null ? workspaces : order.flatMap((id) => byId.get(id) ?? []);

	const run = (action: () => Promise<unknown>) => {
		setError(null);
		action().catch((cause: unknown) => setError(describe(cause)));
	};

	const addWorkspace = () =>
		run(async () => {
			const workspace = await create({
				payload: { name: `Workspace ${workspaces.length + 1}`, icon: "app-window" },
				reactivityKeys: workspacesKey,
			});
			setCreated(workspace.id);
		});

	const dragOver = (overId: string) => {
		if (dragging === null || dragging === overId) return;
		const ids = listed.map((workspace) => workspace.id).filter((id) => id !== dragging);
		const at = listed.findIndex((workspace) => workspace.id === overId);
		const from = listed.findIndex((workspace) => workspace.id === dragging);
		// Moving down lands after the hovered row, moving up before it.
		ids.splice(from < at ? at : ids.indexOf(overId), 0, dragging);
		setOrder(ids);
	};

	const dragEnd = () => {
		setDragging(null);
		if (order === null || sameOrder(order, workspaces)) return;
		run(() => reorder({ payload: { ids: order }, reactivityKeys: workspacesKey }));
	};

	return (
		<Page
			title="Workspaces"
			description="Each workspace is a tab in the title bar. Its place in the list is its keyboard shortcut."
		>
			<Section title="Your Workspaces">
				<Group>
					{listed.map((workspace, index) => (
						<div
							key={workspace.id}
							data-workspace={workspace.id}
							className={`flex items-center gap-2 px-3 py-2.5 ${dragging === workspace.id ? "opacity-50" : ""}`}
							onDragOver={(event) => {
								event.preventDefault();
								dragOver(workspace.id);
							}}
							onDrop={(event) => event.preventDefault()}
						>
							<span
								draggable
								aria-label={`Reorder ${workspace.name}`}
								title="Drag to reorder"
								className="grid size-7 cursor-grab place-items-center text-ink-muted/60 active:cursor-grabbing"
								onDragStart={(event) => {
									event.dataTransfer.effectAllowed = "move";
									const row = event.currentTarget.parentElement;
									if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
									setDragging(workspace.id);
								}}
								onDragEnd={dragEnd}
							>
								<GripVertical className="size-4" />
							</span>
							<IconPicker workspace={workspace} onError={setError} />
							<NameField workspace={workspace} autoFocus={workspace.id === created} onError={setError} />
							<Keys>{shortcutLabel(index + 1)}</Keys>
							<DeleteButton workspace={workspace} disabled={workspaces.length === 1} onError={setError} />
						</div>
					))}
					<button
						type="button"
						disabled={workspaces.length >= MAX}
						title={workspaces.length >= MAX ? `All ${MAX} workspaces are in use` : undefined}
						className="flex items-center gap-2 rounded-b-xl px-5 py-4 text-ink-muted transition-colors hover:bg-ink/4 hover:text-ink disabled:pointer-events-none disabled:opacity-50"
						onClick={addWorkspace}
					>
						<Plus className="size-4" />
						New workspace
					</button>
				</Group>
				{error !== null && <p className="text-destructive">{error}</p>}
			</Section>
			<Section title="Shortcuts">
				<Group>
					<Row title="Switch workspace" description="Jump to a workspace by its place in the list">
						<Keys>
							{shortcutLabel(1)}–{MAX}
						</Keys>
					</Row>
					<Row title="Open settings">
						<Keys>{isMac ? "⌘," : "Ctrl+,"}</Keys>
					</Row>
					<Row title="Close settings" description="Back to the workspace you came from">
						<Keys>Esc</Keys>
					</Row>
				</Group>
			</Section>
		</Page>
	);
}

interface RowProps {
	readonly workspace: Workspace;
	readonly onError: (message: string) => void;
}

/** Renames in place: commits on Enter or blur, Escape restores the saved name. */
function NameField({ workspace, autoFocus, onError }: RowProps & { readonly autoFocus: boolean }) {
	const save = useAtomSet(updateWorkspace, { mode: "promise" });
	const [draft, setDraft] = useState<string | null>(null);
	// Reads the field itself: Escape resets it just before blurring, sooner than state would.
	const commit = (value: string) => {
		const name = value.trim();
		setDraft(null);
		if (!name || name === workspace.name) return;
		save({ payload: { id: workspace.id, name }, reactivityKeys: workspacesKey }).catch((cause: unknown) =>
			onError(describe(cause)),
		);
	};
	return (
		<Input
			aria-label="Workspace name"
			value={draft ?? workspace.name}
			autoFocus={autoFocus}
			onFocus={(event) => autoFocus && event.currentTarget.select()}
			className="h-8 min-w-24 flex-1 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
			onChange={(event) => setDraft(event.target.value)}
			onBlur={(event) => commit(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") {
					event.currentTarget.value = workspace.name;
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

function IconPicker({ workspace, onError }: RowProps) {
	const save = useAtomSet(updateWorkspace, { mode: "promise" });
	const [open, setOpen] = useState(false);
	const Icon = iconOf(workspace.icon);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon" className="size-8" aria-label={`Icon for ${workspace.name}`}>
					<Icon strokeWidth={1.75} />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="grid w-auto grid-cols-6 gap-1 p-2">
				{Object.entries(icons).map(([name, Choice]) => (
					<Button
						key={name}
						variant={name === workspace.icon ? "secondary" : "ghost"}
						size="icon"
						className="size-8"
						aria-label={name}
						aria-pressed={name === workspace.icon}
						onClick={() => {
							setOpen(false);
							if (name === workspace.icon) return;
							save({ payload: { id: workspace.id, icon: name }, reactivityKeys: workspacesKey }).catch(
								(cause: unknown) => onError(describe(cause)),
							);
						}}
					>
						<Choice strokeWidth={1.75} />
					</Button>
				))}
			</PopoverContent>
		</Popover>
	);
}

/** Deletes after a confirm that says which widgets close with it. */
function DeleteButton({ workspace, disabled, onError }: RowProps & { readonly disabled: boolean }) {
	const remove = useAtomSet(deleteWorkspace, { mode: "promise" });
	const [desk, setDesk] = useAtom(deskAtom);
	const tag = workspaceTag(workspace);
	const closing = only(desk, tag).length;
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 text-ink-muted hover:text-destructive"
					disabled={disabled}
					aria-label={`Delete ${workspace.name}`}
					title={disabled ? "The last workspace can't be deleted" : `Delete ${workspace.name}`}
				>
					<Trash2 />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						{closing === 0
							? "No widgets are open only here; widgets shared with other workspaces stay there."
							: `${closing} ${closing === 1 ? "widget is" : "widgets are"} open only here and will close. Widgets shared with other workspaces stay there.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						className="bg-destructive text-white hover:bg-destructive/90"
						onClick={() =>
							remove({ payload: { id: workspace.id }, reactivityKeys: workspacesKey }).then(
								() => setDesk((current) => untag(current, tag)),
								(cause: unknown) => onError(describe(cause)),
							)
						}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

const describe = (cause: unknown) =>
	typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
		? cause.message
		: String(cause);
