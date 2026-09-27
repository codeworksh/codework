import { app, dialog, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RepoRow, RepoState } from "./bridge.ts";
import { UnlinkedRepo } from "./bridge.ts";

const empty: RepoState = { repos: [] };

const fileOf = () => join(app.getPath("userData"), "repos.json");

const read = (): RepoState => {
	const file = fileOf();
	if (!existsSync(file)) return empty;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return empty;
		const repos = "repos" in parsed && Array.isArray(parsed.repos) ? parsed.repos : [];
		const rows = repos.flatMap((row): ReadonlyArray<RepoRow> => {
			if (typeof row !== "object" || row === null || !("path" in row) || typeof row.path !== "string") return [];
			return [{ path: row.path, name: basename(row.path) }];
		});
		const selected =
			"selected" in parsed && typeof parsed.selected === "string"
				? parsed.selected
				: (rows[0]?.path ?? UnlinkedRepo);
		return { repos: rows, selected };
	} catch {
		return empty;
	}
};

const write = (state: RepoState) => {
	const file = fileOf();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`);
};

const rowOf = (path: string): RepoRow => {
	const resolved = realpathSync(path);
	return { path: resolved, name: basename(resolved) };
};

export const list = (): RepoState => {
	const state = read();
	if (state.selected !== undefined) return state;
	return { ...state, selected: state.repos[0]?.path ?? UnlinkedRepo };
};

export const select = (path: string): RepoState => {
	const state = list();
	const next = { ...state, selected: path };
	write(next);
	return next;
};

export const add = (path: string): RepoState => {
	const row = rowOf(path);
	const state = list();
	const repos = [row, ...state.repos.filter((current) => current.path !== row.path)];
	const next = { repos, selected: row.path };
	write(next);
	return next;
};

export const remove = (path: string): RepoState => {
	const state = list();
	const repos = state.repos.filter((row) => row.path !== path);
	const selected = state.selected === path ? (repos[0]?.path ?? UnlinkedRepo) : (state.selected ?? UnlinkedRepo);
	const next = { repos, selected };
	write(next);
	return next;
};

export const open = async (window: BrowserWindow | undefined): Promise<RepoState | undefined> => {
	const options: Electron.OpenDialogOptions = { title: "Open repository", properties: ["openDirectory"] };
	const picked =
		window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
	const path = picked.filePaths[0];
	if (picked.canceled || path === undefined) return undefined;
	return add(path);
};

export * as Repos from "./repos.ts";
