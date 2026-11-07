import { Archive, Folder, Trash2, Undo2 } from "@/components/vuesax";
import { useState } from "react";

import { ProviderIcon } from "@/components/provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Group, Page, Row, Section } from "./blocks";
import { EmptyState } from "./controls";
import { Badge } from "./servers/local";

interface ArchivedSessionItem {
	readonly id: string;
	readonly title: string;
	readonly project: string;
	readonly provider: string;
	readonly updatedDate: string;
}

interface ArchivedProjectItem {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly sessionsCount: number;
}

const INITIAL_SESSIONS: readonly ArchivedSessionItem[] = [
	{
		id: "ses_01jn8k3m",
		title: "Migrate OAuth token storage and refresh locks",
		project: "codework",
		provider: "anthropic",
		updatedDate: "Mar 28",
	},
	{
		id: "ses_01jn5v2p",
		title: "Debug WebSocket ndjson backpressure on slow subscribers",
		project: "codework",
		provider: "openai-codex",
		updatedDate: "Mar 21",
	},
	{
		id: "ses_01jm9q8x",
		title: "Benchmark prompt cache retention across OpenRouter models",
		project: "aikit",
		provider: "openrouter",
		updatedDate: "Mar 14",
	},
];

const INITIAL_PROJECTS: readonly ArchivedProjectItem[] = [
	{
		id: "prj_legacy_tui",
		name: "codework-tui-prototype",
		path: "~/personal/open-source/archive/codework-tui-prototype",
		sessionsCount: 12,
	},
	{
		id: "prj_aikit_bench",
		name: "aikit-eval-suite",
		path: "~/personal/open-source/archive/aikit-eval-suite",
		sessionsCount: 5,
	},
];

export function ArchiveSettings() {
	const [showArchived, setShowArchived] = useState(false);
	const [sessions, setSessions] = useState<readonly ArchivedSessionItem[]>(INITIAL_SESSIONS);
	const [projects, setProjects] = useState<readonly ArchivedProjectItem[]>(INITIAL_PROJECTS);

	return (
		<Page title="Archive" description="Projects and conversations you have archived.">
			<Section title="Display">
				<Group>
					<Row
						title="Show archived in the sidebar"
						description="Keep archived sessions visible alongside active ones in the project tree."
					>
						<Switch
							aria-label="Show archived in the sidebar"
							checked={showArchived}
							onCheckedChange={setShowArchived}
						/>
					</Row>
				</Group>
			</Section>

			<Section title={`Archived Sessions (${sessions.length})`}>
				{sessions.length === 0 ? (
					<EmptyState
						icon={<Archive className="size-6" />}
						title="No archived sessions"
						description="Sessions you archive from a workspace or the threads list appear here."
					/>
				) : (
					<Group>
						{sessions.map((session) => (
							<div key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
								<div className="flex min-w-0 flex-1 items-center gap-3">
									<span className="grid size-7 shrink-0 place-items-center rounded-md border border-edge bg-ink/3 text-ink-muted">
										<ProviderIcon id={session.provider} name={session.provider} className="size-3.5" />
									</span>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<span className="truncate font-medium text-ink">{session.title}</span>
										<Badge tone="muted">{session.project}</Badge>
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<span className="text-xs text-ink-muted">{session.updatedDate}</span>
									<Button
										size="xs"
										variant="secondary"
										onClick={() => setSessions((current) => current.filter((item) => item.id !== session.id))}
									>
										<Undo2 className="size-3" aria-hidden />
										Unarchive
									</Button>
									<Button
										size="icon-xs"
										variant="ghost"
										aria-label={`Delete ${session.title}`}
										title="Delete permanently"
										className="text-ink-muted hover:text-destructive"
										onClick={() => setSessions((current) => current.filter((item) => item.id !== session.id))}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							</div>
						))}
					</Group>
				)}
			</Section>

			<Section title={`Archived Projects (${projects.length})`}>
				{projects.length === 0 ? (
					<EmptyState
						icon={<Folder className="size-6" />}
						title="No archived projects"
						description="Projects you archive from the Projects view are kept here with their history intact."
					/>
				) : (
					<Group>
						{projects.map((project) => (
							<div key={project.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex items-center gap-2">
										<span className="font-medium text-ink">{project.name}</span>
										<Badge tone="muted">{project.sessionsCount} sessions</Badge>
									</div>
									<span className="truncate font-mono text-2xs text-ink-muted">{project.path}</span>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<Button
										size="xs"
										variant="secondary"
										onClick={() => setProjects((current) => current.filter((item) => item.id !== project.id))}
									>
										<Undo2 className="size-3" aria-hidden />
										Unarchive
									</Button>
									<Button
										size="icon-xs"
										variant="ghost"
										aria-label={`Delete ${project.name}`}
										title="Delete project"
										className="text-ink-muted hover:text-destructive"
										onClick={() => setProjects((current) => current.filter((item) => item.id !== project.id))}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							</div>
						))}
					</Group>
				)}
			</Section>
		</Page>
	);
}
