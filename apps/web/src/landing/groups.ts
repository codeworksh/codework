import type { Priority, SidebarProject, SidebarSession, ThreadStatus } from "@codeworksh/contract";
import { Option, Schema } from "effect";
import { Activity, Clock, Flag, Folder, SquarePlus } from "@/components/vuesax";
import { useState } from "react";

import { PRIORITIES, PRIORITY, STATUS, STATUSES } from "../widgets/threads/marks";

/** How the sidebar lists sessions: what it groups them by, and the order of rows and project groups. */
export const Display = Schema.Struct({
	group: Schema.Literals(["project", "status", "priority"]),
	order: Schema.Literals(["updated", "created"]),
});
export type Display = typeof Display.Type;

export const GROUPS: ReadonlyArray<{
	readonly value: Display["group"];
	readonly label: string;
	readonly icon: typeof Folder;
}> = [
	{ value: "project", label: "Project", icon: Folder },
	{ value: "status", label: "Status", icon: Activity },
	{ value: "priority", label: "Priority", icon: Flag },
];
export const ORDERS: ReadonlyArray<{
	readonly value: Display["order"];
	readonly label: string;
	readonly icon: typeof Folder;
}> = [
	{ value: "updated", label: "Last Updated", icon: Clock },
	{ value: "created", label: "Created", icon: SquarePlus },
];

const DEFAULTS: Display = { group: "project", order: "updated" };
const displayKey = "codework.sidebar.display";
const decodeDisplay = Schema.decodeUnknownOption(Schema.fromJsonString(Display));

/** The sidebar's display options, kept in this window's storage so it reopens as left. */
export function useDisplay() {
	const [display, setDisplay] = useState<Display>(() => {
		try {
			return Option.getOrElse(decodeDisplay(localStorage.getItem(displayKey)), () => DEFAULTS);
		} catch {
			// Storage can be unavailable; the defaults apply.
			return DEFAULTS;
		}
	});
	const change = (patch: Partial<Display>) => {
		const next = { ...display, ...patch };
		setDisplay(next);
		try {
			localStorage.setItem(displayKey, JSON.stringify(next));
		} catch {
			// The options still apply until the page closes.
		}
	};
	return [display, change] as const;
}

/** A session with the project it is in, which a status or priority group mixes. */
export interface Entry {
	readonly session: SidebarSession;
	readonly project: SidebarProject;
}

/** One sidebar group: a project, a status or a priority, with its sessions in the chosen order. */
export type Group =
	| {
			readonly kind: "project";
			readonly key: string;
			readonly project: SidebarProject;
			readonly entries: ReadonlyArray<Entry>;
	  }
	| {
			readonly kind: "status";
			readonly key: string;
			readonly status: ThreadStatus;
			readonly entries: ReadonlyArray<Entry>;
	  }
	| {
			readonly kind: "priority";
			readonly key: string;
			readonly priority: Priority;
			readonly entries: ReadonlyArray<Entry>;
	  };

export const groupLabel = (group: Group) =>
	group.kind === "project"
		? group.project.name
		: group.kind === "status"
			? STATUS[group.status].label
			: PRIORITY[group.priority].label;

/**
 * `projects` as the sidebar groups them, newest first by `display.order`, keeping sessions matching
 * `needle`. Groups with no session drop, except a project's while not searching, so its first
 * thread can be started from it.
 */
export function groupsOf(projects: ReadonlyArray<SidebarProject>, display: Display, needle: string): Group[] {
	const time = (session: SidebarSession) => (display.order === "created" ? session.created : session.updated);
	const newest = (a: Entry, b: Entry) => time(b.session) - time(a.session);
	const entries = (project: SidebarProject) =>
		project.sessions
			.map((session) => ({ session, project }))
			.filter(({ session }) => needle === "" || `${session.title} ${project.name}`.toLowerCase().includes(needle));

	if (display.group === "project") {
		// A project's own creation orders it by created; by updated, its newest session's activity, as listed.
		const projectTime = (project: SidebarProject, index: number) =>
			display.order === "created" ? project.created : -index;
		return projects
			.map((project, index) => ({
				project,
				at: projectTime(project, index),
				entries: entries(project).toSorted(newest),
			}))
			.filter(({ entries }) => entries.length > 0 || needle === "")
			.toSorted((a, b) => b.at - a.at)
			.map(({ project, entries }) => ({
				kind: "project",
				key: `${project.machine.id}/${project.id}`,
				project,
				entries,
			}));
	}

	const all = projects.flatMap(entries).toSorted(newest);
	if (display.group === "status")
		return STATUSES.map((status): Group => ({
			kind: "status",
			key: `status/${status}`,
			status,
			entries: all.filter(({ session }) => session.status === status),
		})).filter((group) => group.entries.length > 0);
	return PRIORITIES.map((priority): Group => ({
		kind: "priority",
		key: `priority/${priority}`,
		priority,
		entries: all.filter(({ session }) => session.priority === priority),
	})).filter((group) => group.entries.length > 0);
}
