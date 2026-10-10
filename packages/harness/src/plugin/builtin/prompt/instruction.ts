/*
 * Discovery happens only in the sandbox namespace, local or remote: never through the host
 * filesystem (`hostDir`, `hostCwd`) and never from a global `<home>` file. The walk ends at the
 * sandbox root, which on a local sandbox is `/`, so a `~/AGENTS.md` above the cwd loads like any
 * other ancestor's file.
 */

import * as Section from "@codeworksh/plugin/plugin/section";
import { Effect, Option } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { posix } from "../../../util/posix.ts";
import type { SharedPluginContext } from "../../context.ts";
import { define } from "../../plugin.ts";

/** First readable match per directory wins. */
const names: ReadonlyArray<string> = [
	"AGENTS.override.md",
	"CLAUDE.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];

export interface Found {
	readonly name: string;
	readonly path: string;
	/** Undefined for a file with nothing to say, which still claims its directory. */
	readonly content: string | undefined;
}

const content = (raw: string): string | undefined => {
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	return text.trim().length === 0 ? undefined : text;
};

/** `directory` and every ancestor up to the sandbox root, closest first. */
const ancestors = (directory: string): string[] => {
	const chain: string[] = [];
	for (let current = directory; ; current = posix.dirname(current)) {
		chain.push(current);
		if (posix.dirname(current) === current) return chain;
	}
};

/**
 * Which of `paths` are files. Absence is the expected answer and stays silent; any other failure
 * (permissions, a remote blip) is logged so a dropped file is not a mystery, then counts as absent.
 */
const present = (fs: SandboxFileSystem.Interface, paths: ReadonlyArray<string>) =>
	Effect.forEach(
		paths,
		(path) =>
			fs.stat(path).pipe(
				Effect.map((stat) => stat.isFile),
				Effect.catch((error) =>
					SandboxFileSystem.isNotFoundError(error.cause)
						? Effect.succeed(false)
						: Effect.logWarning(`could not stat instruction file ${path}`, error.cause).pipe(Effect.as(false)),
				),
			),
		{ concurrency: "unbounded" },
	).pipe(Effect.map((hits) => new Set(paths.filter((_, index) => hits[index]))));

/** A file that stats but does not read falls through to the next candidate. */
const first = Effect.fnUntraced(function* (
	fs: SandboxFileSystem.Interface,
	directory: string,
	files: ReadonlySet<string>,
) {
	for (const name of names) {
		const path = posix.join(directory, name);
		if (!files.has(path)) continue;
		const raw = yield* fs.readFile(path).pipe(
			Effect.tapError((error) => Effect.logWarning(`could not read instruction file ${path}`, error.cause)),
			Effect.option,
		);
		if (Option.isSome(raw)) return { name, path, content: content(raw.value) } satisfies Found;
	}
	return undefined;
});

/** Only the path is escaped; file content goes in verbatim. */
const attribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * The main checkout's directory when the cwd is in a linked worktree nested inside it (e.g.
 * `repo/.claude/worktrees/x`), so its same-named file is not applied twice. Sibling worktrees,
 * bare layouts and submodules are never shadowed.
 */
const shadowing = (location: SharedPluginContext["location"]): string | undefined => {
	const store = location.project.vcs?.store;
	if (location.space.kind !== "linked" || store === undefined || posix.basename(store) !== ".git") return undefined;
	const main = posix.dirname(store);
	return location.space.location.startsWith(`${main}/`) ? main : undefined;
};

/** One file per directory from the sandbox root down to the cwd, closest last so it has the final word. */
export const discover = Effect.fnUntraced(function* (
	fs: SandboxFileSystem.Interface,
	location: SharedPluginContext["location"],
) {
	const chain = ancestors(location.directory);
	// Every candidate of every directory is probed in one batch: on a remote sandbox each stat is a
	// network round trip, so a serial walk cost 6 x depth of them before every model call.
	const files = yield* present(
		fs,
		chain.flatMap((directory) => names.map((name) => posix.join(directory, name))),
	);
	const found = yield* Effect.forEach(chain, (directory) => first(fs, directory, files), {
		concurrency: "unbounded",
	});

	// The worktree root is always on the chain, since the cwd is at or beneath it.
	const main = shadowing(location);
	const worktree = main === undefined ? undefined : found[chain.indexOf(location.space.location)];
	const walked: Found[] = [];
	for (const [index, here] of found.entries()) {
		const shadowed = chain[index] === main && worktree !== undefined && here?.name === worktree.name;
		if (here !== undefined && !shadowed) walked.push(here);
	}
	return walked.reverse();
});

export const instructionPlugin = define({
	id: "codework.prompt.instruction",
	kind: "prompt",
	setup: Effect.fn("InstructionPlugin.setup")(function* (ctx) {
		const fs = yield* SandboxIO.FileSystem;
		const files = (yield* discover(fs, ctx.location)).filter((file) => file.content !== undefined);
		if (files.length === 0) return;

		const prompt = ctx.plugin.prompt;
		prompt.sections.append(Section.ProjectContext, "Project-Specific Instructions & Guidelines:");
		for (const file of files)
			prompt.sections.append(
				Section.ProjectContext,
				`<project_instructions path="${attribute(file.path)}">\n${file.content}\n</project_instructions>`,
			);
	}),
});
