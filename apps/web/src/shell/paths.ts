import type { Folder } from "@codeworksh/contract";

/*
 * Path and clone-URL rules for adding a project from the palette, as T3 Code has them. Only POSIX
 * paths: the app runs on macOS and Linux.
 */

/** A query that names a folder rather than searching: absolute, or from home. */
export const isBrowseQuery = (query: string) => query.startsWith("/") || query.startsWith("~/");

/** The folder a browse query lists: everything up to its last `/`. */
export const directoryOf = (query: string) => query.slice(0, query.lastIndexOf("/") + 1);

/** What a browse query filters that folder's entries by: the text after its last `/`. */
export const leafOf = (query: string) => query.slice(query.lastIndexOf("/") + 1);

/** The folder above a listed one, or null at `/` and `~/`. */
export function parentOf(directory: string) {
	const trimmed = directory.slice(0, -1);
	if (trimmed === "" || trimmed === "~") return null;
	return directoryOf(trimmed);
}

/** A path as a folder to list: with its trailing `/`. */
const asDirectory = (path: string) => (path === "" || path.endsWith("/") ? path : `${path}/`);

/** Entries matching the leaf by prefix, ignoring case; dot-folders only once the leaf starts with a dot. */
export function filterFolders(entries: ReadonlyArray<Folder>, leaf: string) {
	const lower = leaf.toLowerCase();
	const hidden = leaf.startsWith(".");
	const visible = entries.filter(
		(entry) => entry.name.toLowerCase().startsWith(lower) && (hidden || !entry.name.startsWith(".")),
	);
	const exact = leaf === "" ? undefined : visible.find((entry) => entry.name === leaf);
	return { visible, exact };
}

/**
 * Shell-style Tab: one match completes to it, several extend the leaf to their common prefix; null
 * when Tab would change nothing.
 */
export function complete(visible: ReadonlyArray<Folder>, leaf: string) {
	const [first, ...rest] = visible;
	if (first === undefined) return null;
	if (rest.length === 0) return { name: first.name, done: true };
	let prefix = Array.from(first.name);
	for (const entry of rest) {
		const chars = Array.from(entry.name);
		let n = 0;
		while (n < prefix.length && prefix[n]?.toLowerCase() === chars[n]?.toLowerCase()) n++;
		prefix = prefix.slice(0, n);
	}
	const name = prefix.join("");
	return name.length > leaf.length ? { name, done: false } : null;
}

/** `path` with the home folder shown as `~`. */
export const tilde = (path: string, home: string | undefined) =>
	home !== undefined && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

const SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/** A pasted clone URL; `owner/repo` shorthand means GitHub over https. */
export function cloneUrl(input: string) {
	const trimmed = input.trim();
	if (!SHORTHAND.test(trimmed)) return trimmed;
	return `https://github.com/${trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`}`;
}

/** An owner with nothing after the slash yet. */
export const ownerOnly = (input: string) => /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/.test(input.trim());

/** The folder a clone of `source` (a URL or owner/repo) goes into; empty when it names none. */
export function cloneName(source: string) {
	const url = source.split(/[?#]/)[0]?.trim() ?? "";
	const scheme = url.indexOf("://");
	const hasHost = scheme >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(url);
	const rest = scheme >= 0 ? url.slice(scheme + 3) : url;
	const segments = rest.split(/[/\\:]+/).filter((segment) => segment.trim() !== "");
	if (hasHost && segments.length < 2) return "";
	const last = segments.at(-1)?.trim() ?? "";
	if (hasHost && segments.length === 2 && /^\d+$/.test(last)) return "";
	return last.endsWith(".git") ? last.slice(0, -4) : last;
}

/** Where a clone named `name` lands inside `directory`. */
export const cloneTarget = (directory: string, name: string) =>
	name.trim() === "" ? directory : `${asDirectory(directory)}${name.trim()}`;

/** The folder a new project named `name` gets, as the server derives it. */
export function projectFolder(name: string) {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64)
		.replace(/-+$/, "");
	if (slug === "") return "project";
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `${slug}-project` : slug;
}

// Finder copies a path ready for a shell: `'/a b'` or `/a\'s\ b`.
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

/**
 * What a folder box holds after a change. A full path pasted into it replaces the box, even after
 * the text already there, because `~/'/a b'` would create that nested folder.
 */
export function pastedPath(previous: string, next: string) {
	const typing = next.startsWith(previous) ? next.length === previous.length + 1 : previous.startsWith(next);
	if (typing) return next;

	const match = QUOTED_PATH_AT_END.exec(next);
	// Text before the quote that wasn't in the box is a search, not a folder to paste after.
	if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
		const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? "";
		if (isBrowseQuery(quoted)) return quoted;
	}

	// Without a trailing `/`, `/a` then `/a/b` is a longer path, not one pasted after a folder.
	const afterFolder = previous.endsWith("/") && next.startsWith(previous);
	const path = afterFolder ? next.slice(previous.length) : next;
	return isBrowseQuery(path) ? path.replace(SHELL_ESCAPE, "$1") : next;
}
