import { DotsSixVerticalIcon, PlusIcon, StackIcon, TrashIcon } from "@phosphor-icons/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { messageOf } from "@/lib/utils";
import { isMac } from "@codeworksh/widget/view";
import { shortcutLabel } from "../shell/switcher";
import { deskAtom, deskKey, only } from "../wm/instances";
import {
	deleteWorkspace,
	reorderWorkspaces,
	lastWorkspaceAtom,
	MAX_WORKSPACES,
	updateWorkspace,
	useCreateWorkspace,
	useWorkspaces,
	type Workspace,
	workspacesKey,
	workspaceTag,
} from "../wm/workspaces";
import { Group, Keys, SavingInput, Page, Row, Section } from "./blocks";

/** Move one id to its final position, shared by drag and keyboard reordering. */
function moveTo(ids: readonly string[], from: number, to: number): string[] {
	const next = [...ids];
	const [id] = next.splice(from, 1);
	if (id !== undefined) next.splice(to, 0, id);
	return next;
}

const sameOrder = (ids: readonly string[], workspaces: readonly Workspace[]) =>
	ids.length === workspaces.length && ids.every((id, index) => workspaces[index]?.id === id);

/** List, create, rename, reorder (drag the grip), and delete workspaces. */
export function WorkspacesSettings() {
	const workspaces = useWorkspaces();
	const create = useCreateWorkspace();
	const desk = useAtomValue(deskAtom);
	const current = useAtomValue(lastWorkspaceAtom);
	const [adding, setAdding] = useState(false);
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
		action().catch((cause: unknown) => setError(messageOf(cause)));
	};

	const addWorkspace = () => {
		setAdding(true);
		run(async () => {
			try {
				const workspace = await create({ name: `Workspace ${workspaces.length + 1}` });
				setCreated(workspace.id);
			} finally {
				setAdding(false);
			}
		});
	};

	const saveOrder = (ids: readonly string[]) => {
		setOrder(ids);
		run(async () => {
			try {
				await reorder({ payload: { ids }, reactivityKeys: workspacesKey });
			} catch (cause) {
				setOrder(null);
				throw cause;
			}
		});
	};

	const dragOver = (overId: string) => {
		if (dragging === null || dragging === overId) return;
		const ids = listed.map((workspace) => workspace.id);
		setOrder(moveTo(ids, ids.indexOf(dragging), ids.indexOf(overId)));
	};

	const dragEnd = () => {
		setDragging(null);
		if (order !== null && !sameOrder(order, workspaces)) saveOrder(order);
	};

	return (
		<Page
			title="Workspaces"
			description="Keep related sessions together, with a tab and panel layout for each workspace."
			actions={
				<Button
					size="sm"
					variant="secondary"
					disabled={adding || workspaces.length >= MAX_WORKSPACES}
					title={workspaces.length >= MAX_WORKSPACES ? `All ${MAX_WORKSPACES} workspaces are in use` : undefined}
					onClick={addWorkspace}
				>
					<PlusIcon aria-hidden />
					{adding ? "Creating…" : "New workspace"}
				</Button>
			}
		>
			<Section title="Your workspaces">
				<Group>
					{listed.map((workspace, index) => {
						const panels = desk.instances.filter(
							(instance) => (instance.tags & workspaceTag(workspace)) !== 0,
						).length;
						return (
							<div
								key={workspace.id}
								data-workspace={workspace.id}
								className={`group/workspace flex items-center gap-3 px-4 py-3 ${dragging === workspace.id ? "bg-selection-subtle opacity-50" : ""}`}
								onDragOver={(event) => {
									event.preventDefault();
									dragOver(workspace.id);
								}}
								onDrop={(event) => event.preventDefault()}
							>
								<button
									type="button"
									draggable={listed.length > 1}
									disabled={listed.length < 2}
									aria-label={`Reorder ${workspace.name}`}
									title="Drag to reorder, or use the up and down arrow keys"
									aria-describedby="workspace-order-help"
									className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-ink-muted/50 outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
									onKeyDown={(event) => {
										if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
										event.preventDefault();
										const target = index + (event.key === "ArrowUp" ? -1 : 1);
										if (target >= 0 && target < listed.length)
											saveOrder(
												moveTo(
													listed.map(({ id }) => id),
													index,
													target,
												),
											);
									}}
									onDragStart={(event) => {
										event.dataTransfer.effectAllowed = "move";
										const row = event.currentTarget.parentElement;
										if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
										setDragging(workspace.id);
									}}
									onDragEnd={dragEnd}
								>
									<DotsSixVerticalIcon className="size-4" aria-hidden />
								</button>
								<span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-ink/3 text-ink-muted @min-[440px]:flex">
									<StackIcon className="size-4" aria-hidden />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex min-w-0 items-center gap-2">
										<NameField
											key={workspace.id === created ? "created" : workspace.id}
											workspace={workspace}
											autoFocus={workspace.id === created}
											onError={setError}
										/>
										{workspace.id === current && (
											<span className="hidden shrink-0 rounded-md bg-brand/10 px-1.5 py-0.5 text-2xs font-medium text-brand @min-[560px]:inline">
												Current
											</span>
										)}
									</div>
									<p className="px-2 text-xs text-ink-muted">
										{panels} {panels === 1 ? "panel" : "panels"} ·{" "}
										{workspace.layout === "monocle" ? "Focused view" : "Tiled view"}
									</p>
								</div>
								<Keys>{shortcutLabel(index + 1)}</Keys>
								<DeleteButton workspace={workspace} onError={setError} />
							</div>
						);
					})}
					{listed.length === 0 && (
						<div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
							<StackIcon className="mb-1 size-6 text-ink-muted" aria-hidden />
							<p className="font-medium">No workspaces yet</p>
							<p className="text-ink-muted">Create a workspace to organize your sessions.</p>
						</div>
					)}
				</Group>
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1 text-xs text-ink-muted">
					<p id="workspace-order-help" className="max-w-sm leading-relaxed">
						Rename inline; changes save automatically. Drag the handles or use ↑ ↓ while a handle is focused to
						reorder tabs and shortcuts.
					</p>
					<span className="shrink-0 tabular-nums">
						{workspaces.length} of {MAX_WORKSPACES} workspaces
					</span>
				</div>
				{error !== null && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
			</Section>
			<Section title="Shortcuts">
				<Group>
					<Row title="Switch workspace" description="Jump to a tab by its position in your list.">
						<Keys>
							{shortcutLabel(1)}–{MAX_WORKSPACES}
						</Keys>
					</Row>
					<Row title="Open settings">
						<Keys>{isMac ? "⌘," : "Ctrl+,"}</Keys>
					</Row>
					<Row title="Close settings" description="Return to your last workspace.">
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
	return (
		<SavingInput
			label={`Name for ${workspace.name}`}
			value={workspace.name}
			autoFocus={autoFocus}
			// Reads as plain text in the row until hovered or focused.
			className="h-7 min-w-0 flex-1 rounded-md border-transparent bg-transparent px-2 font-medium shadow-none hover:border-edge hover:bg-ink/3 focus-visible:border-edge-focus dark:bg-transparent"
			onCommit={(name) => {
				// A workspace keeps its name when the field is cleared.
				if (!name) return;
				save({ payload: { id: workspace.id, name }, reactivityKeys: workspacesKey }).catch((cause: unknown) =>
					onError(messageOf(cause)),
				);
			}}
		/>
	);
}

/** Deletes after a confirm that says which widgets close with it. */
function DeleteButton({ workspace, onError }: RowProps) {
	const remove = useAtomSet(deleteWorkspace, { mode: "promise" });
	const desk = useAtomValue(deskAtom);
	const tag = workspaceTag(workspace);
	const closing = only(desk, tag).length;
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 text-ink-muted hover:text-destructive"
					aria-label={`Delete ${workspace.name}`}
					title={`Delete ${workspace.name}`}
				>
					<TrashIcon />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						Its tab and shortcut go away.{" "}
						{closing === 0
							? "Panels shared with other workspaces stay open."
							: `${closing} ${closing === 1 ? "panel" : "panels"} open only here will close; shared panels stay.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() =>
							// The server drops the workspace's widgets, so the desk reloads with the list.
							remove({ payload: { id: workspace.id }, reactivityKeys: [...workspacesKey, ...deskKey] }).catch(
								(cause: unknown) => onError(messageOf(cause)),
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
