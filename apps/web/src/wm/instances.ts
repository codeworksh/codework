import { workspaceTag } from "./workspaces";

/**
 * One placed copy of a widget. The window manager owns instances; a widget only
 * ever sees its own id and decoded props.
 */
export interface Instance {
	readonly id: string;
	/** Registered widget kind; an unknown kind renders a "missing widget" frame. */
	readonly kind: string;
	/** webwm tag mask: the workspaces this instance appears on. */
	readonly tags: number;
	/** Saved settings, decoded by the widget's own schema before it renders. */
	readonly props: unknown;
	/** Overrides the widget's default title. */
	readonly title?: string;
}

const [main, code, notes] = [workspaceTag(1), workspaceTag(2), workspaceTag(3)];

// Hardcoded until instances live in SQLite. Tile order follows this list, so
// Files is the master on Main; Chat and Terminal sit on two workspaces at once.
export const instances: readonly Instance[] = [
	{ id: "files", kind: "explorer", tags: main, props: { root: "/Users/sanchitrk/Developer/codeworksh/codework" } },
	{ id: "chat", kind: "placeholder", title: "Chat", tags: main | code, props: {} },
	{ id: "terminal", kind: "placeholder", title: "Terminal", tags: main | code, props: {} },
	{ id: "preview", kind: "placeholder", title: "Preview", tags: main, props: {} },
	{ id: "editor", kind: "placeholder", title: "Editor", tags: code, props: {} },
	{ id: "notes", kind: "placeholder", title: "Notes", tags: notes, props: {} },
];
