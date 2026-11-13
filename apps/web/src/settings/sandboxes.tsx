import { CubeIcon, GitBranchIcon, PlusIcon, StopIcon, TrashIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Code, Group, Page, quietField, Row, Section } from "./blocks";
import { EmptyState, StatusDot } from "./controls";
import { Badge } from "./servers/local";

interface SandboxInstanceItem {
	readonly id: string;
	readonly driver: "memory" | "vercel" | "daytona";
	readonly kind: "local" | "remote";
	readonly resourceId?: string;
	readonly refCount: number;
	readonly status: "running" | "stopping";
	readonly createdAgo: string;
}

interface WorktreeItem {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly branch: string;
	readonly sessions: number;
	readonly dirty: boolean;
	readonly unpushed: number;
}

const DRIVERS = [
	{
		id: "host",
		name: "Local Host",
		kind: "local",
		ready: true,
		detail: "Runs directly in the project's host folder.",
	},
	{
		id: "memory",
		name: "Memory",
		kind: "local",
		ready: true,
		detail: "Isolated copy-on-write virtual filesystem in RAM.",
	},
	{ id: "vercel", name: "Vercel Sandbox", kind: "remote", ready: true, detail: "Cloud microVM via @vercel/sandbox." },
	{
		id: "daytona",
		name: "Daytona",
		kind: "remote",
		ready: false,
		detail: "Set DAYTONA_API_KEY to provision cloud workspaces.",
	},
] as const;

const INITIAL_INSTANCES: readonly SandboxInstanceItem[] = [
	{
		id: "sbx_01jp9k2m7v",
		driver: "vercel",
		kind: "remote",
		resourceId: "vcel_vm_8821a",
		refCount: 2,
		status: "running",
		createdAgo: "18m ago",
	},
	{
		id: "sbx_01jp8w4a1c",
		driver: "memory",
		kind: "local",
		refCount: 1,
		status: "running",
		createdAgo: "42m ago",
	},
];

const INITIAL_WORKTREES: readonly WorktreeItem[] = [
	{
		id: "wt-mcp-settings",
		name: "codework-mcp-settings",
		path: "~/personal/open-source/worktrees/codework-mcp-settings",
		branch: "feat/mcp-settings",
		sessions: 2,
		dirty: true,
		unpushed: 1,
	},
	{
		id: "wt-rpc-sync",
		name: "codework-rpc-sync",
		path: "~/personal/open-source/worktrees/codework-rpc-sync",
		branch: "fix/rpc-reconnect",
		sessions: 0,
		dirty: false,
		unpushed: 0,
	},
];

let nextSandboxSeq = 1;

export function SandboxesSettings() {
	const [defaultDriver, setDefaultDriver] = useState<string>("host");
	const [instances, setInstances] = useState<readonly SandboxInstanceItem[]>(INITIAL_INSTANCES);
	const [worktrees, setWorktrees] = useState<readonly WorktreeItem[]>(INITIAL_WORKTREES);
	const [creatingWorktree, setCreatingWorktree] = useState(false);

	const provisionSandbox = (driver: "memory" | "vercel") => {
		const seq = nextSandboxSeq++;
		const id = `sbx_01jp9x${String(seq).padStart(4, "0")}`;
		setInstances((current) => [
			{
				id,
				driver,
				kind: driver === "vercel" ? "remote" : "local",
				...(driver === "vercel" ? { resourceId: `vcel_vm_9${String(seq).padStart(4, "0")}` } : {}),
				refCount: 0,
				status: "running",
				createdAgo: "just now",
			},
			...current,
		]);
	};

	return (
		<Page
			title="Sandboxes"
			description="Manage isolated execution sandboxes and parallel git worktrees for your sessions."
		>
			<Section title="Default Environment">
				<Group>
					<Row
						title="New session environment"
						description="Where new sessions run their shell commands and file edits unless overridden."
					>
						<Select value={defaultDriver} onValueChange={setDefaultDriver}>
							<SelectTrigger
								size="sm"
								aria-label="New session environment"
								className={`${quietField} min-w-44 text-xs`}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="host" className="text-xs">
									Local Host
								</SelectItem>
								<SelectItem value="memory" className="text-xs">
									In-Memory Sandbox
								</SelectItem>
								<SelectItem value="vercel" className="text-xs">
									Vercel Cloud Sandbox
								</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</Group>
			</Section>

			<Section title="Sandbox Drivers">
				<Group>
					{DRIVERS.map((driver) => (
						<div key={driver.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div className="flex min-w-0 flex-1 items-start gap-3">
								<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink-muted">
									<CubeIcon className="size-4" aria-hidden />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-ink">{driver.name}</span>
										<Code>{driver.id}</Code>
										<Badge tone={driver.ready ? "success" : "muted"}>
											{driver.ready ? "Available" : "Not configured"}
										</Badge>
										<Badge tone="muted">{driver.kind}</Badge>
									</div>
									<span className="text-xs text-ink-muted">{driver.detail}</span>
								</div>
							</div>
							{(driver.id === "memory" || driver.id === "vercel") && (
								<Button size="sm" variant="secondary" onClick={() => provisionSandbox(driver.id)}>
									<PlusIcon className="size-3.5" aria-hidden />
									Start instance
								</Button>
							)}
						</div>
					))}
				</Group>
			</Section>

			<Section title={`Active Sandbox Instances (${instances.length})`}>
				{instances.length === 0 ? (
					<EmptyState
						icon={<CubeIcon className="size-6" />}
						title="No active sandboxes"
						description="Managed sandboxes start automatically when a session requests one and stop when you end them."
					/>
				) : (
					<Group>
						{instances.map((instance) => (
							<div key={instance.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-mono text-ui font-medium text-ink">{instance.id}</span>
										<Badge tone="info">{instance.driver}</Badge>
										{instance.resourceId !== undefined && <Code>{instance.resourceId}</Code>}
									</div>
									<StatusDot tone="success">
										Running · {instance.refCount}{" "}
										{instance.refCount === 1 ? "session attached" : "sessions attached"} · created{" "}
										{instance.createdAgo}
									</StatusDot>
								</div>
								<Button
									size="sm"
									variant="secondary"
									onClick={() => setInstances((current) => current.filter((item) => item.id !== instance.id))}
								>
									<StopIcon className="size-3" aria-hidden />
									Stop
								</Button>
							</div>
						))}
					</Group>
				)}
			</Section>

			<Section title="Git Worktrees">
				<div className="mb-1 flex flex-wrap items-center justify-between gap-2">
					<span className="text-xs text-ink-muted">
						Linked worktrees let sessions work on separate branches concurrently without stashing.
					</span>
					<Button size="sm" variant="secondary" onClick={() => setCreatingWorktree(true)}>
						<PlusIcon aria-hidden />
						Create Worktree
					</Button>
				</div>
				{worktrees.length === 0 ? (
					<EmptyState
						icon={<TreeStructureIcon className="size-6" />}
						title="No additional worktrees"
						description="Create a worktree to run sessions on another branch in an isolated folder."
					/>
				) : (
					<Group>
						{worktrees.map((tree) => (
							<div key={tree.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
								<div className="flex min-w-0 flex-1 items-start gap-3">
									<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink-muted">
										<TreeStructureIcon className="size-4" aria-hidden />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-ink">{tree.name}</span>
											<span className="inline-flex items-center gap-1 rounded-md bg-ink/6 px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">
												<GitBranchIcon className="size-3" aria-hidden />
												{tree.branch}
											</span>
											<Badge tone={tree.dirty ? "warning" : "success"}>
												{tree.dirty ? "Uncommitted changes" : "Clean"}
											</Badge>
										</div>
										<span className="truncate font-mono text-2xs text-ink-muted">{tree.path}</span>
										<span className="text-xs text-ink-muted">
											{tree.sessions} {tree.sessions === 1 ? "session" : "sessions"} in this worktree
											{tree.unpushed > 0 ? ` · ${tree.unpushed} unpushed commit` : ""}
										</span>
									</div>
								</div>
								<Button
									size="icon-xs"
									variant="ghost"
									aria-label={`Delete worktree ${tree.name}`}
									title="Remove worktree"
									className="text-ink-muted hover:text-destructive"
									onClick={() => setWorktrees((current) => current.filter((item) => item.id !== tree.id))}
								>
									<TrashIcon className="size-3.5" />
								</Button>
							</div>
						))}
					</Group>
				)}
			</Section>

			{creatingWorktree && (
				<CreateWorktreeDialog
					onClose={() => setCreatingWorktree(false)}
					onCreate={(tree) => {
						setWorktrees((current) => [tree, ...current]);
						setCreatingWorktree(false);
					}}
				/>
			)}
		</Page>
	);
}

function CreateWorktreeDialog({
	onClose,
	onCreate,
}: {
	readonly onClose: () => void;
	readonly onCreate: (tree: WorktreeItem) => void;
}) {
	const [branch, setBranch] = useState("");
	const cleanBranch = branch.trim();
	const folderName = `codework-${cleanBranch.replace(/[^a-zA-Z0-9-_]+/g, "-") || "branch"}`;

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 text-sm sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create Worktree</DialogTitle>
					<DialogDescription>
						Check out a new or existing branch into a linked folder under{" "}
						<Code>~/personal/open-source/worktrees</Code>.
					</DialogDescription>
				</DialogHeader>
				<label className="flex flex-col gap-1 text-xs text-ink-muted">
					<span>Branch name</span>
					<Input
						value={branch}
						autoFocus
						placeholder="feat/parallel-agent"
						className={`${quietField} font-mono text-xs`}
						onChange={(event) => setBranch(event.target.value)}
					/>
				</label>
				<p className="text-2xs text-ink-muted">
					Folder: <Code>{`~/personal/open-source/worktrees/${folderName}`}</Code>
				</p>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={!cleanBranch}
						onClick={() =>
							onCreate({
								id: `wt-${Date.now()}`,
								name: folderName,
								path: `~/personal/open-source/worktrees/${folderName}`,
								branch: cleanBranch,
								sessions: 0,
								dirty: false,
								unpushed: 0,
							})
						}
					>
						Create Worktree
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
