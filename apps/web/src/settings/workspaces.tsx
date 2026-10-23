import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { messageOf } from "@/lib/utils";
import { isMac } from "@codeworksh/widget/view";
import { shortcutLabel } from "../shell/switcher";
import { deskAtom, deskKey, only } from "../wm/instances";
import {
	deleteWorkspace,
	reorderWorkspaces,
	MAX_WORKSPACES,
	updateWorkspace,
	useCreateWorkspace,
	useWorkspaces,
	type Workspace,
	workspacesKey,
	workspaceTag,
} from "../wm/workspaces";
import { Group, Keys, SavingInput, Page, Row, Section } from "./blocks";

const sameOrder = (ids: readonly string[], workspaces: readonly Workspace[]) =>
	ids.length === workspaces.length && ids.every((id, index) => workspaces[index]?.id === id);

/** List, create, rename, reorder (drag the grip), and delete workspaces. */
export function WorkspacesSettings() {
	const workspaces = useWorkspaces();
	const create = useCreateWorkspace();
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

	const addWorkspace = () =>
		run(async () => {
			const workspace = await create({ name: `Workspace ${workspaces.length + 1}` });
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
							<NameField workspace={workspace} autoFocus={workspace.id === created} onError={setError} />
							<Keys>{shortcutLabel(index + 1)}</Keys>
							<DeleteButton workspace={workspace} onError={setError} />
						</div>
					))}
					<button
						type="button"
						disabled={workspaces.length >= MAX_WORKSPACES}
						title={
							workspaces.length >= MAX_WORKSPACES ? `All ${MAX_WORKSPACES} workspaces are in use` : undefined
						}
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
							{shortcutLabel(1)}–{MAX_WORKSPACES}
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
	return (
		<SavingInput
			label="Workspace name"
			value={workspace.name}
			autoFocus={autoFocus}
			// Reads as plain text in the row until hovered or focused.
			className="h-8 min-w-24 flex-1 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
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
					<Trash2 />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						Its tab and shortcut go away.{" "}
						{closing === 0
							? "Widgets shared with other workspaces stay where they are."
							: `${closing} ${closing === 1 ? "widget" : "widgets"} open only here will close; shared widgets stay.`}
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
