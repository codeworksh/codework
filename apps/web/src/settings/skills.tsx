import {
	Check,
	ChevronRight,
	Copy,
	DocumentText,
	Plus,
	RefreshCw,
	Search,
	Sparkles,
	Trash2,
} from "@/components/vuesax";
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
import { Switch } from "@/components/ui/switch";
import { Code, Group, Page, quietField, Section } from "./blocks";
import { EmptyState, Segmented } from "./controls";
import { Badge } from "./servers/local";

type SkillScope = "project" | "personal" | "builtin";

interface SkillItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly scope: SkillScope;
	readonly path: string;
	readonly enabled: boolean;
	readonly content: string;
}

const INITIAL_SKILLS: readonly SkillItem[] = [
	{
		id: "effect-architecture",
		name: "effect-architecture",
		description: "Idiomatic Effect service definitions, Schema codecs, and Layer composition patterns.",
		scope: "project",
		path: ".codework/skills/effect-architecture/SKILL.md",
		enabled: true,
		content: `---\nname: effect-architecture\ndescription: Idiomatic Effect service definitions, Schema codecs, and Layer composition patterns.\n---\n\n# Effect Architecture Guidelines\n\n1. Define services with \`Context.Service\` and expose a clean \`layer\` constructor.\n2. Keep wire and persistence boundaries typed with \`Schema\`.\n3. Avoid leaking raw promises or untyped exceptions across service boundaries.`,
	},
	{
		id: "e2e-artifacts",
		name: "e2e-artifacts",
		description: "End-to-end test execution with deterministic path-normalized __artifacts__ snapshots.",
		scope: "project",
		path: ".codework/skills/e2e-artifacts/SKILL.md",
		enabled: true,
		content: `---\nname: e2e-artifacts\ndescription: End-to-end test execution with deterministic path-normalized __artifacts__ snapshots.\n---\n\n# E2E Artifact Verification\n\n- Spawn the real CLI or server runtime against a temporary home directory.\n- Normalize dynamic IDs, ports, and timestamps before asserting.\n- Persist repeatable JSON snapshots under \`test/__artifacts__/\`.`,
	},
	{
		id: "release-workflow",
		name: "release-workflow",
		description: "Changelog curation, package version bumping, and canary/latest publishing steps.",
		scope: "personal",
		path: "~/.codework/skills/release-workflow/SKILL.md",
		enabled: true,
		content: `---\nname: release-workflow\ndescription: Changelog curation, package version bumping, and canary/latest publishing steps.\n---\n\n# Release Flow\n\n1. Move entries from \`[Unreleased]\` in \`CHANGELOG.md\`.\n2. Run \`vp run bump <pkg>\` for each modified package.\n3. Preview with \`vp run release latest --dry-run\`.`,
	},
	{
		id: "mcp-troubleshooting",
		name: "mcp-troubleshooting",
		description: "Diagnose stdio and HTTP MCP server connection, OAuth, and schema validation issues.",
		scope: "builtin",
		path: "builtin://skills/mcp-troubleshooting/SKILL.md",
		enabled: true,
		content: `---\nname: mcp-troubleshooting\ndescription: Diagnose stdio and HTTP MCP server connection, OAuth, and schema validation issues.\n---\n\n# MCP Troubleshooting\n\n- Inspect \`~/.codework/mcp.log\` for skipped tools or transport errors.\n- Run \`codework mcp list\` to verify tool exposure and connection state.`,
	},
	{
		id: "legacy-migration",
		name: "legacy-migration",
		description: "Playbook for migrating legacy REST endpoints to typed Effect RPC contracts.",
		scope: "personal",
		path: "~/.codework/skills/legacy-migration/SKILL.md",
		enabled: false,
		content: `---\nname: legacy-migration\ndescription: Playbook for migrating legacy REST endpoints to typed Effect RPC contracts.\n---\n\n# Legacy RPC Migration\n\nDefine request, success, and tagged error schemas in \`contract.ts\` and wire handlers in \`handlers.ts\`.`,
	},
];

const SCOPE_BADGE: Record<SkillScope, { label: string; tone: "info" | "success" | "muted" }> = {
	project: { label: "Project", tone: "info" },
	personal: { label: "Personal", tone: "success" },
	builtin: { label: "Built-in", tone: "muted" },
};

export function SkillsSettings() {
	const [skills, setSkills] = useState<readonly SkillItem[]>(INITIAL_SKILLS);
	const [query, setQuery] = useState("");
	const [scopeFilter, setScopeFilter] = useState<"all" | SkillScope>("all");
	const [previewId, setPreviewId] = useState<string | null>("effect-architecture");
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [creating, setCreating] = useState(false);

	const normalized = query.trim().toLowerCase();
	const visible = skills.filter((skill) => {
		if (scopeFilter !== "all" && skill.scope !== scopeFilter) return false;
		if (normalized === "") return true;
		return `${skill.name} ${skill.description} ${skill.path} ${skill.scope}`.toLowerCase().includes(normalized);
	});

	const refresh = () => {
		setRefreshing(true);
		setTimeout(() => setRefreshing(false), 450);
	};

	const copyPath = (skill: SkillItem) => {
		void navigator.clipboard?.writeText(skill.path);
		setCopiedId(skill.id);
		setTimeout(() => setCopiedId(null), 1600);
	};

	return (
		<Page
			title="Skills"
			description="Discover and manage SKILL.md instruction files from project, personal, and built-in folders."
			actions={
				<div className="flex items-center gap-2">
					<Button size="sm" variant="ghost" disabled={refreshing} className="text-ink-muted" onClick={refresh}>
						<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
						<span className="hidden @min-[560px]:inline">{refreshing ? "Scanning…" : "Refresh"}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
						<Plus aria-hidden />
						Add Skill
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between">
				<div className="relative flex-1">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<Input
						type="search"
						value={query}
						placeholder="Filter skills by name, description, or path…"
						aria-label="Filter skills"
						className={`${quietField} h-8 pl-8 text-xs`}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				<Segmented
					label="Filter skills by scope"
					value={scopeFilter}
					options={[
						{ value: "all", label: `All (${skills.length})` },
						{ value: "project", label: "Project" },
						{ value: "personal", label: "Personal" },
						{ value: "builtin", label: "Built-in" },
					]}
					onChange={setScopeFilter}
				/>
			</div>

			<Section title={`Discovered Skills (${visible.length})`}>
				{visible.length === 0 ? (
					<EmptyState
						icon={<Sparkles className="size-6" />}
						title="No matching skills"
						description={
							query.trim() !== ""
								? `No skill matches “${query}”.`
								: "Create a SKILL.md in your project or personal folder to teach the agent repeatable workflows."
						}
					/>
				) : (
					<Group>
						{visible.map((skill) => {
							const badge = SCOPE_BADGE[skill.scope];
							const previewing = previewId === skill.id;
							const copied = copiedId === skill.id;
							return (
								<div key={skill.id} className={`flex flex-col ${!skill.enabled ? "opacity-60" : ""}`}>
									<div className="flex flex-wrap items-center gap-3 px-4 py-3">
										<button
											type="button"
											aria-expanded={previewing}
											aria-label={`${previewing ? "Hide" : "Preview"} ${skill.name} SKILL.md`}
											onClick={() => setPreviewId(previewing ? null : skill.id)}
											className="flex min-w-0 flex-1 items-start gap-3 text-left outline-none"
										>
											<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink-muted">
												<DocumentText className="size-4" strokeWidth={1.75} aria-hidden />
											</span>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<div className="flex flex-wrap items-center gap-2">
													<span className="font-mono text-ui font-medium text-ink">{skill.name}</span>
													<Badge tone={badge.tone}>{badge.label}</Badge>
												</div>
												<p className="truncate text-xs text-ink-muted">{skill.description}</p>
												<span className="truncate font-mono text-2xs text-ink-muted/75">{skill.path}</span>
											</div>
											<ChevronRight
												className={`mt-1 size-4 shrink-0 text-ink-muted transition-transform ${
													previewing ? "rotate-90" : ""
												}`}
												aria-hidden
											/>
										</button>

										<div className="flex shrink-0 items-center gap-1.5">
											<Button
												size="icon-xs"
												variant="ghost"
												aria-label={`Copy path for ${skill.name}`}
												title={copied ? "Copied" : "Copy path"}
												onClick={() => copyPath(skill)}
											>
												{copied ? (
													<Check className="size-3.5 text-success" />
												) : (
													<Copy className="size-3.5" />
												)}
											</Button>
											{skill.scope !== "builtin" && (
												<Button
													size="icon-xs"
													variant="ghost"
													aria-label={`Remove ${skill.name}`}
													title="Remove skill"
													className="text-ink-muted hover:text-destructive"
													onClick={() =>
														setSkills((current) => current.filter((item) => item.id !== skill.id))
													}
												>
													<Trash2 className="size-3.5" />
												</Button>
											)}
											<Switch
												aria-label={`Enable ${skill.name}`}
												checked={skill.enabled}
												onCheckedChange={(enabled) =>
													setSkills((current) =>
														current.map((item) => (item.id === skill.id ? { ...item, enabled } : item)),
													)
												}
											/>
										</div>
									</div>

									{previewing && (
										<div className="flex flex-col gap-2 border-t border-edge/40 bg-ink/2 px-4 py-3">
											<div className="flex items-center justify-between text-2xs text-ink-muted">
												<span>
													Previewing <Code>{skill.path}</Code>
												</span>
												<span>SKILL.md</span>
											</div>
											<pre className="max-h-56 overflow-auto rounded-lg border border-edge/60 bg-ink/4 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-secondary">
												{skill.content}
											</pre>
										</div>
									)}
								</div>
							);
						})}
					</Group>
				)}
			</Section>

			<p className="text-xs text-ink-muted">
				CodeWork scans <Code>.codework/skills/*/SKILL.md</Code> in the project and{" "}
				<Code>~/.codework/skills/*/SKILL.md</Code> in your home directory.
			</p>

			{creating && (
				<CreateSkillDialog
					onClose={() => setCreating(false)}
					onCreate={(item) => {
						setSkills((current) => [item, ...current]);
						setPreviewId(item.id);
						setCreating(false);
					}}
				/>
			)}
		</Page>
	);
}

function CreateSkillDialog({
	onClose,
	onCreate,
}: {
	readonly onClose: () => void;
	readonly onCreate: (skill: SkillItem) => void;
}) {
	const [scope, setScope] = useState<"project" | "personal">("project");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const path =
		scope === "project"
			? `.codework/skills/${slug || "my-skill"}/SKILL.md`
			: `~/.codework/skills/${slug || "my-skill"}/SKILL.md`;

	const submit = () => {
		if (!slug) return;
		const desc = description.trim() || `Custom ${scope} skill instructions.`;
		onCreate({
			id: `${slug}-${Date.now()}`,
			name: slug,
			description: desc,
			scope,
			path,
			enabled: true,
			content: `---\nname: ${slug}\ndescription: ${desc}\n---\n\n# ${slug}\n\nWrite instructions and examples for the agent here.`,
		});
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 text-sm sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Create Skill</DialogTitle>
					<DialogDescription>
						Scaffold a new <Code>SKILL.md</Code> instruction file.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between">
					<span className="text-xs text-ink-muted">Location</span>
					<Segmented
						label="Skill scope"
						value={scope}
						options={[
							{ value: "project", label: "Project (.codework/skills)" },
							{ value: "personal", label: "Personal (~/.codework/skills)" },
						]}
						onChange={setScope}
					/>
				</div>

				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>Skill name</span>
						<Input
							value={name}
							autoFocus
							placeholder="api-conventions"
							className={`${quietField} font-mono text-xs`}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>Description (when the agent should load this skill)</span>
						<Input
							value={description}
							placeholder="Use when adding or modifying RPC endpoints and schemas."
							className={`${quietField} text-xs`}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
					<p className="text-2xs text-ink-muted">
						Will create <Code>{path}</Code>
					</p>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={!slug} onClick={submit}>
						Create Skill
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
