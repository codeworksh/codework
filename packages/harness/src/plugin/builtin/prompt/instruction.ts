/*
 * Files are read only through the sandbox, never from the host (`hostDir`, `hostCwd`, `<home>`):
 * a host-side global file would be read twice whenever a local sandbox's walk passes through it.
 */

import * as Section from "@codeworksh/plugin/plugin/section";
import { Effect, Option } from "effect";
import type { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
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

interface Found {
	readonly name: string;
	readonly path: string;
	/** Undefined for a file with nothing to say, which still claims its directory. */
	readonly content: string | undefined;
}

const content = (raw: string): string | undefined => {
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	return text.trim().length === 0 ? undefined : text;
};

const first = Effect.fnUntraced(function* (fs: SandboxFileSystem.Interface, directory: string) {
	for (const name of names) {
		const path = posix.join(directory, name);
		const isFile = yield* fs.stat(path).pipe(
			Effect.map((stat) => stat.isFile),
			Effect.orElseSucceed(() => false),
		);
		if (!isFile) continue;
		const raw = yield* fs.readFile(path).pipe(
			Effect.tapError((cause) => Effect.logWarning(`could not read instruction file ${path}`, cause)),
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

export const instructionPlugin = define({
	id: "codework.prompt.instruction",
	kind: "prompt",
	setup: Effect.fn("InstructionPlugin.setup")(function* (ctx) {
		const fs = yield* SandboxIO.FileSystem;

		// The worktree root is probed before the walk and again during it.
		const probed = new Map<string, Found | undefined>();
		const at = Effect.fnUntraced(function* (directory: string) {
			if (!probed.has(directory)) probed.set(directory, yield* first(fs, directory));
			return probed.get(directory);
		});

		const walked: Found[] = [];
		const main = shadowing(ctx.location);
		const worktree = main === undefined ? undefined : yield* at(ctx.location.space.location);
		let current: string = ctx.location.directory;
		while (true) {
			const here = yield* at(current);
			const shadowed = current === main && worktree !== undefined && here?.name === worktree.name;
			if (here !== undefined && !shadowed) walked.push(here);
			const parent = posix.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		// Closest file last, so it has the final word.
		const files = walked.reverse().filter((file) => file.content !== undefined);
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
