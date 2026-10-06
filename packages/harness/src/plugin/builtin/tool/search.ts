import { Effect, Layer, Schema } from "effect";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { NonNegativeInt, PositiveInt } from "../../../schema.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { fromSandboxShell, type IToolShell, ToolShell } from "../../../tool/shell.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../../tool/truncate.ts";
import * as Tool from "../../../tool/tool.ts";
import { posix } from "../../../util/posix.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in search plugin — one tool for both ways an agent looks for text:
 *
 * - `mode: "content"` (default) finds a regex in file contents and reports the
 *   matching lines, grouped by file, with optional surrounding context.
 * - `mode: "files"` finds files whose path matches a glob/needle.
 *
 * Two backends, picked by capability. When the sandbox's shell can run
 * `ripgrep`, we stream `rg --json` (fast, and rg's own `.gitignore`/hidden
 * handling). Otherwise — just-bash/VFS mounts, remote microVMs without rg, a
 * host without rg installed — we walk {@link SandboxIO.FileSystem} in-process.
 * The walk reimplements the same selection rules so a query returns the same
 * set of matches either way; it only varies which runs.
 *
 * The definition is pure data; the handler depends on `SandboxIO.FileSystem` and
 * `ToolShell`, so the backend (host / VFS / remote) is whatever the mount
 * provides.
 */

const SearchMode = Schema.Literals(["content", "files"]);

const SearchParams = Schema.Struct({
	query: Schema.String.annotate({
		description:
			'What to look for. Content mode: a regular expression (or a literal string when "literal" is true). Files mode: a glob (e.g. "**/*.test.ts") or a plain path fragment.',
	}),
	mode: Schema.optional(
		SearchMode.annotate({
			description: 'Defaults to "content". Use "files" to find files by name/path instead of searching contents.',
		}),
	),
	path: Schema.optional(
		Schema.String.annotate({
			description:
				"File or directory to search. Relative paths resolve against the working directory. Defaults to the working directory.",
		}),
	),
	include: Schema.optional(
		Schema.String.annotate({
			description: 'Content mode only: only search files whose path matches this glob, e.g. "*.ts" or "*.{ts,tsx}".',
		}),
	),
	literal: Schema.optional(
		Schema.Boolean.annotate({ description: "Content mode: treat the query as a literal string instead of a regex." }),
	),
	ignoreCase: Schema.optional(Schema.Boolean.annotate({ description: "Case-insensitive matching." })),
	multiline: Schema.optional(
		Schema.Boolean.annotate({ description: "Content mode: allow the pattern to match across line boundaries." }),
	),
	context: Schema.optional(
		PositiveInt.annotate({ description: "Content mode: lines of context to show before and after each match." }),
	),
	limit: Schema.optional(
		PositiveInt.annotate({
			description: "Maximum matches (content) or files (files) to return. Defaults to 100, capped at 500.",
		}),
	),
	offset: Schema.optional(
		NonNegativeInt.annotate({
			description: "Skip this many matches/files before returning results (pagination). Defaults to 0.",
		}),
	),
	noIgnore: Schema.optional(
		Schema.Boolean.annotate({
			description: "Include files normally skipped by .gitignore and dotfiles. Off by default, like ripgrep.",
		}),
	),
});

const SearchSuccess = Schema.Struct({
	/** Model-facing report: matches grouped by file, plus a pagination/truncation footer. */
	content: Schema.String,
	/** Matches shown (content mode) or files shown (files mode). */
	matches: NonNegativeInt,
	/** Distinct files represented in `content`. */
	files: NonNegativeInt,
	/** True when results were cut short by `limit`, the byte cap, or a timeout. */
	truncated: Schema.Boolean,
	/** True when more matches exist beyond what was returned. */
	hasMore: Schema.Boolean,
	/** Which backend ran. Same results either way; useful for diagnostics. */
	backend: Schema.Literals(["ripgrep", "walk"]),
});

const SearchReason = Schema.Literals([
	"path_not_found",
	"not_a_directory",
	"invalid_pattern",
	"invalid_glob",
	"timeout",
]);

class SearchFailed extends Schema.TaggedError<SearchFailed>()("SearchFailed", {
	query: Schema.String,
	reason: SearchReason,
	message: Schema.String,
}) {}

const SearchFailure = Schema.Union([SearchFailed]);

export const searchDef = Tool.define({
	name: "search",
	label: "search",
	promptSnippet: "Search file contents by regex, or find files by name.",
	promptGuidelines: [
		"Use search to locate code instead of shelling out to grep, find, or rg via bash.",
		'Prefer a narrow "include"/"path"; use mode "files" to locate a file by name.',
	],
	description:
		'Search a codebase. With mode "content" (default) it returns matching lines grouped by file; with mode "files" it lists files whose path matches the query. ' +
		"By default it skips files ignored by .gitignore and dotfiles, and skips binary files; set noIgnore to include them. " +
		`Output is capped at ${DEFAULT_MAX_BYTES / 1024}KB and to limit matches. When truncated, continue with a larger offset. ` +
		"A missing path or an invalid pattern is an error.",
	parameters: SearchParams,
	success: SearchSuccess,
	failure: SearchFailure,
	encodeContent: (success) => [{ type: "text", text: success.content }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
});

// ── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_CONTEXT = 0;
/** Files larger than this are skipped by the walk backend (they are rarely source, and never worth the bytes). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Safety valve: never walk more than this many files in one call. */
const FILE_CAP = 20_000;
const SEARCH_TIMEOUT = "20 seconds" as const;

/** Directory names skipped by the walk when `noIgnore` is off; mirrors what rg ignores out of the box. */
const DEFAULT_IGNORES = [
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".turbo",
	".cache",
	"coverage",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
] as const;

// ── Shared value types ──────────────────────────────────────────────────────

interface LineRef {
	readonly line: number;
	readonly text: string;
}

/** One matching line plus the context lines around it. */
interface MatchEntry {
	readonly match: LineRef;
	readonly before: ReadonlyArray<LineRef>;
	readonly after: ReadonlyArray<LineRef>;
}

interface FileHit {
	readonly path: string;
	readonly entries: ReadonlyArray<MatchEntry>;
}

const plural = (count: number, singular: string, pluralForm: string): string =>
	`${count === 1 ? singular : pluralForm}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

/** A glob with metacharacters matches with minimatch; a plain string is a path substring. */
const matchesPath = (path: string, pattern: string, ignoreCase: boolean): boolean => {
	const hasGlob = /[*?[\]{}()!+@]/.test(pattern);
	if (hasGlob) {
		return minimatch(path, pattern, { dot: true, matchBase: true, nocase: ignoreCase });
	}
	const haystack = ignoreCase ? path.toLowerCase() : path;
	const needle = ignoreCase ? pattern.toLowerCase() : pattern;
	return haystack.includes(needle);
};

// ── Ignore handling (the walk backend's half of rg's gitignore behavior) ─────

interface IgnoreMatcher {
	readonly add: (patterns: ReadonlyArray<string>) => void;
	readonly ignored: (rel: string, isDirectory: boolean) => boolean;
}

/**
 * A live gitignore matcher over paths relative to the search root.
 *
 * Patterns from a nested `.gitignore` are rebased onto the root: anchored ones
 * get the directory prefix and a leading slash, while unanchored ones are
 * widened to "dir/globstar/pattern" (which also matches "dir/pattern", as git
 * does). This is a close approximation of per-directory gitignore precedence
 * rather than a byte-exact reimplementation; the common cases — node_modules,
 * build output, anchored and basename patterns — all behave as expected.
 */
const makeIgnoreMatcher = (noIgnore: boolean): IgnoreMatcher => {
	const manager = ignore();
	if (!noIgnore) manager.add([...DEFAULT_IGNORES]);
	return {
		add: (patterns) => {
			if (patterns.length > 0) manager.add([...patterns]);
		},
		ignored: (rel, isDirectory) => {
			if (rel === "") return false;
			if (!noIgnore && rel.split("/").some((segment) => segment.startsWith("."))) return true;
			return manager.ignores(rel) || (isDirectory && manager.ignores(`${rel}/`));
		},
	};
};

const expandGitignoreLine = (base: string, rawLine: string): ReadonlyArray<string> => {
	const line = rawLine.replace(/\r$/, "").trimEnd();
	if (line.trim() === "" || line.trimStart().startsWith("#")) return [];
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	}
	if (pattern === "") return [];
	const trailingSlash = pattern.endsWith("/");
	const body = trailingSlash ? pattern.slice(0, -1) : pattern;
	const anchored = body.startsWith("/") || body.includes("/");
	const normalized = body.startsWith("/") ? body.slice(1) : body;
	const suffix = trailingSlash ? "/" : "";
	const prefix = negated ? "!" : "";
	if (anchored) {
		const joined = base === "" ? normalized : `${base}/${normalized}`;
		return [`${prefix}/${joined}${suffix}`];
	}
	if (base === "") return [`${prefix}${normalized}${suffix}`];
	return [`${prefix}${base}/**/${normalized}${suffix}`];
};

// ── ripgrep JSON wire parsing ───────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
	typeof value === "object" && value !== null ? (value as JsonObject) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

interface RawLine {
	readonly line: number;
	readonly text: string;
	readonly isMatch: boolean;
}

interface RawFile {
	readonly path: string;
	readonly lines: ReadonlyArray<RawLine>;
}

/** Parse `rg --json` (JSON Lines) into ordered, per-file line lists. */
const parseRipgrep = (stdout: string): ReadonlyArray<RawFile> => {
	const files: RawFile[] = [];
	let current: { path: string; lines: RawLine[] } | undefined;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const event = asObject(parsed);
		if (event === undefined) continue;
		const type = asString(event.type);
		if (type === "begin") {
			const path = asString(asObject(asObject(event.data)?.path)?.text);
			if (path !== undefined) {
				current = { path, lines: [] };
				files.push(current);
			}
		} else if ((type === "match" || type === "context") && current !== undefined) {
			const data = asObject(event.data);
			const text = stripTrailingNewline(asString(asObject(data?.lines)?.text) ?? "");
			const lineNumber = asNumber(data?.line_number) ?? 0;
			current.lines.push({ line: lineNumber, text, isMatch: type === "match" });
		}
	}
	return files;
};

/** Turn a file's ordered match/context lines into entries with resolved context. */
const entriesFromRawFile = (file: RawFile, context: number): ReadonlyArray<MatchEntry> => {
	const entries: MatchEntry[] = [];
	for (let index = 0; index < file.lines.length; index++) {
		const line = file.lines[index];
		if (line === undefined || !line.isMatch) continue;
		const before: LineRef[] = [];
		for (let i = index - 1; i >= 0; i--) {
			const candidate = file.lines[i];
			if (candidate === undefined || candidate.isMatch || line.line - candidate.line > context) break;
			before.unshift({ line: candidate.line, text: candidate.text });
		}
		const after: LineRef[] = [];
		for (let i = index + 1; i < file.lines.length; i++) {
			const candidate = file.lines[i];
			if (candidate === undefined || candidate.isMatch || candidate.line - line.line > context) break;
			after.push({ line: candidate.line, text: candidate.text });
		}
		entries.push({ match: { line: line.line, text: line.text }, before, after });
	}
	return entries;
};

// ── Walk backend ────────────────────────────────────────────────────────────

const loadGitignore = (fs: SandboxFileSystem.Interface, dir: string, matcher: IgnoreMatcher): Effect.Effect<void> =>
	Effect.gen(function* () {
		const path = dir === "" ? ".gitignore" : `${dir}/.gitignore`;
		const text = yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => undefined));
		if (text === undefined) return;
		matcher.add(text.split("\n").flatMap((line) => expandGitignoreLine(dir, line)));
	});

/**
 * List files under `root`, honouring ignore rules. Returned paths are relative
 * to the mount's working directory and already carry the root prefix, so they
 * are directly displayable and matchable.
 */
const listFiles = (
	fs: SandboxFileSystem.Interface,
	root: string,
	matcher: IgnoreMatcher,
	useGitignore: boolean,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const files: string[] = [];
		const visit = (dir: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const names = yield* fs.readdir(dir === "" ? "." : dir).pipe(Effect.orElseSucceed(() => [] as string[]));
				for (const name of [...names].sort()) {
					if (files.length >= FILE_CAP) return;
					const rel = dir === "" ? name : `${dir}/${name}`;
					const stat = yield* fs.stat(rel).pipe(Effect.orElseSucceed(() => undefined));
					if (stat === undefined) continue;
					if (stat.isDirectory) {
						if (matcher.ignored(rel, true)) continue;
						if (useGitignore) yield* loadGitignore(fs, rel, matcher);
						yield* visit(rel);
					} else if (stat.isFile) {
						if (matcher.ignored(rel, false)) continue;
						files.push(rel);
					}
				}
			});
		if (useGitignore) yield* loadGitignore(fs, root, matcher);
		yield* visit(root);
		return files;
	});

const contextBefore = (lines: ReadonlyArray<string>, index: number, context: number): ReadonlyArray<LineRef> => {
	const from = Math.max(0, index - context);
	return lines.slice(from, index).map((text, offset) => ({ line: from + offset + 1, text }));
};

const contextAfter = (lines: ReadonlyArray<string>, index: number, context: number): ReadonlyArray<LineRef> => {
	const to = Math.min(lines.length, index + 1 + context);
	return lines.slice(index + 1, to).map((text, offset) => ({ line: index + offset + 2, text }));
};

const matchLines = (
	lines: ReadonlyArray<string>,
	lineRegex: RegExp,
	globalRegex: RegExp,
	multiline: boolean,
	context: number,
): ReadonlyArray<MatchEntry> => {
	const entries: MatchEntry[] = [];
	if (multiline) {
		const text = lines.join("\n");
		globalRegex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = globalRegex.exec(text)) !== null) {
			const startLine = (text.slice(0, match.index).match(/\n/g)?.length ?? 0) + 1;
			const index = startLine - 1;
			const firstLine = match[0].split("\n")[0] ?? "";
			entries.push({
				match: { line: startLine, text: firstLine },
				before: contextBefore(lines, index, context),
				after: contextAfter(lines, index, context),
			});
			if (match[0].length === 0) globalRegex.lastIndex += 1;
		}
		return entries;
	}
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index] ?? "";
		if (!lineRegex.test(text)) continue;
		entries.push({
			match: { line: index + 1, text },
			before: contextBefore(lines, index, context),
			after: contextAfter(lines, index, context),
		});
	}
	return entries;
};

// ── Handler ────────────────────────────────────────────────────────────────

const compileRegex = (query: string, flags: string): Effect.Effect<RegExp, SearchFailed> => {
	try {
		return Effect.succeed(new RegExp(query, flags));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Effect.fail(
			new SearchFailed({ query, reason: "invalid_pattern", message: `Invalid pattern: ${message}` }),
		);
	}
};

const probeBackend = (execArgv: IToolShell["execArgv"]): Effect.Effect<"ripgrep" | "walk"> =>
	Effect.gen(function* () {
		if (execArgv === undefined) return "walk" as const;
		const probe = yield* execArgv(["rg", "--version"]).pipe(Effect.orElseSucceed(() => undefined));
		return probe !== undefined && probe.exitCode === 0 ? ("ripgrep" as const) : ("walk" as const);
	});

const describeFiles = (
	paths: ReadonlyArray<string>,
	hasMore: boolean,
	offset: number,
	backend: "ripgrep" | "walk",
): string => {
	if (paths.length === 0) return "No files found.";
	const header = `Found ${paths.length} ${plural(paths.length, "file", "files")}:`;
	const body = paths.join("\n");
	const footer = hasMore
		? `\n\n[Showing ${paths.length} files${offset > 0 ? ` from offset ${offset}` : ""}. More available; continue with offset ${offset + paths.length} or narrow the query.]`
		: "";
	return `${header}\n\n${body}${footer}\n\n(${backend})`;
};

const describeMatches = (
	hits: ReadonlyArray<FileHit>,
	shown: number,
	hasMore: boolean,
	offset: number,
	backend: "ripgrep" | "walk",
): string => {
	if (hits.length === 0) return "No matches.";
	const fileCount = hits.length;
	const header = `Found ${shown} ${plural(shown, "match", "matches")} in ${fileCount} ${plural(fileCount, "file", "files")}:`;
	const sections = hits.map((hit) => {
		const seen = new Set<number>();
		const lines: string[] = [];
		for (const entry of hit.entries) {
			for (const before of entry.before) {
				if (seen.has(before.line)) continue;
				seen.add(before.line);
				lines.push(`  ${before.line}- ${before.text}`);
			}
			if (!seen.has(entry.match.line)) {
				seen.add(entry.match.line);
				lines.push(`  ${entry.match.line}: ${entry.match.text}`);
			}
			for (const after of entry.after) {
				if (seen.has(after.line)) continue;
				seen.add(after.line);
				lines.push(`  ${after.line}- ${after.text}`);
			}
		}
		return `${hit.path}:\n${lines.join("\n")}`;
	});
	const footer = hasMore
		? `\n\n[Showing ${shown} ${plural(shown, "match", "matches")}${offset > 0 ? ` from offset ${offset}` : ""}. More available; continue with offset ${offset + shown} or narrow the query.]`
		: "";
	return `${header}\n\n${sections.join("\n\n")}${footer}\n\n(${backend})`;
};

const runRipgrepContent = (
	execArgv: NonNullable<IToolShell["execArgv"]>,
	params: typeof SearchParams.Type,
	limit: number,
	offset: number,
	context: number,
): Effect.Effect<
	{
		readonly content: string;
		readonly matches: number;
		readonly files: number;
		readonly hasMore: boolean;
		readonly truncated: boolean;
	},
	SearchFailed
> =>
	Effect.gen(function* () {
		const argv: string[] = ["rg", "--json", "--color", "never"];
		if (params.ignoreCase === true) argv.push("-i");
		if (params.literal === true) argv.push("-F");
		if (params.multiline === true) argv.push("-U");
		if (params.noIgnore === true) argv.push("--no-ignore", "--hidden");
		if (params.include !== undefined && params.include !== "") argv.push("-g", params.include);
		if (context > 0) argv.push("-C", String(context));
		argv.push("--", params.query, params.path ?? ".");

		const result = yield* execArgv(argv, { timeout: SEARCH_TIMEOUT }).pipe(
			Effect.mapError((cause) =>
				cause._tag === "ToolShellTimeout"
					? new SearchFailed({
							query: params.query,
							reason: "timeout",
							message: `Search timed out after ${SEARCH_TIMEOUT}.`,
						})
					: new SearchFailed({
							query: params.query,
							reason: "invalid_pattern",
							message: `ripgrep failed: ${String(cause)}`,
						}),
			),
		);
		if (result.exitCode === 2) {
			const message =
				(result.stderr.trim() || result.stdout.trim() || "ripgrep failed").split("\n")[0] ?? "ripgrep failed";
			const reason = /no such file|does not exist|not found/i.test(message) ? "path_not_found" : "invalid_pattern";
			return yield* new SearchFailed({ query: params.query, reason, message });
		}

		const files = parseRipgrep(result.stdout);
		const flattened: { readonly path: string; readonly entry: MatchEntry }[] = [];
		for (const file of files) {
			const path = file.path.replace(/^\.\//, "");
			for (const entry of entriesFromRawFile(file, context)) flattened.push({ path, entry });
		}
		const selected = flattened.slice(offset, offset + limit);
		const hasMore = flattened.length > offset + selected.length;
		const grouped = groupEntries(selected);
		return {
			content: describeMatches(grouped, selected.length, hasMore, offset, "ripgrep"),
			matches: selected.length,
			files: grouped.length,
			hasMore,
			truncated: hasMore,
		};
	});

const runRipgrepFiles = (
	execArgv: NonNullable<IToolShell["execArgv"]>,
	params: typeof SearchParams.Type,
	limit: number,
	offset: number,
): Effect.Effect<
	{
		readonly content: string;
		readonly matches: number;
		readonly files: number;
		readonly hasMore: boolean;
		readonly truncated: boolean;
	},
	SearchFailed
> =>
	Effect.gen(function* () {
		const argv: string[] = ["rg", "--files", "--color", "never"];
		if (params.noIgnore === true) argv.push("--no-ignore", "--hidden");
		argv.push(params.path ?? ".");

		const result = yield* execArgv(argv, { timeout: SEARCH_TIMEOUT }).pipe(
			Effect.mapError((cause) =>
				cause._tag === "ToolShellTimeout"
					? new SearchFailed({
							query: params.query,
							reason: "timeout",
							message: `Search timed out after ${SEARCH_TIMEOUT}.`,
						})
					: new SearchFailed({
							query: params.query,
							reason: "invalid_pattern",
							message: `ripgrep failed: ${String(cause)}`,
						}),
			),
		);
		const ignoreCase = params.ignoreCase === true;
		const all = result.stdout
			.split("\n")
			.map((line) => line.replace(/^\.\//, "").trim())
			.filter((line) => line !== "" && matchesPath(line, params.query, ignoreCase))
			.sort();
		const selected = all.slice(offset, offset + limit);
		const hasMore = all.length > offset + selected.length;
		return {
			content: describeFiles(selected, hasMore, offset, "ripgrep"),
			matches: selected.length,
			files: selected.length,
			hasMore,
			truncated: hasMore,
		};
	});

const groupEntries = (
	flattened: ReadonlyArray<{ readonly path: string; readonly entry: MatchEntry }>,
): ReadonlyArray<FileHit> => {
	const byPath = new Map<string, MatchEntry[]>();
	for (const item of flattened) {
		const existing = byPath.get(item.path);
		if (existing === undefined) byPath.set(item.path, [item.entry]);
		else existing.push(item.entry);
	}
	return [...byPath.entries()].map(([path, entries]) => ({ path, entries }));
};

const runWalk = (
	fs: SandboxFileSystem.Interface,
	params: typeof SearchParams.Type,
	mode: "content" | "files",
	limit: number,
	offset: number,
	context: number,
): Effect.Effect<
	{
		readonly content: string;
		readonly matches: number;
		readonly files: number;
		readonly hasMore: boolean;
		readonly truncated: boolean;
	},
	SearchFailed
> =>
	Effect.gen(function* () {
		const root = (params.path ?? ".").replace(/\/+$/, "") || ".";
		const stat = yield* fs.stat(root).pipe(Effect.orElseSucceed(() => undefined));
		if (stat === undefined) {
			return yield* new SearchFailed({
				query: params.query,
				reason: "path_not_found",
				message: `Path not found: ${params.path ?? "."}`,
			});
		}
		if (!stat.isFile && !stat.isDirectory) {
			return yield* new SearchFailed({
				query: params.query,
				reason: "not_a_directory",
				message: `Not a file or directory: ${params.path ?? "."}`,
			});
		}

		const rootBase = root === "." ? "" : root;
		const matcher = makeIgnoreMatcher(params.noIgnore === true);
		const candidates = stat.isFile
			? [rootBase === "" ? posix.basename(root) : rootBase]
			: yield* listFiles(fs, rootBase, matcher, params.noIgnore !== true);
		const ordered = [...candidates].sort();
		const ignoreCase = params.ignoreCase === true;

		if (mode === "files") {
			const matched = ordered.filter((path) => matchesPath(path, params.query, ignoreCase));
			const selected = matched.slice(offset, offset + limit);
			const hasMore = matched.length > offset + selected.length;
			return {
				content: describeFiles(selected, hasMore, offset, "walk"),
				matches: selected.length,
				files: selected.length,
				hasMore,
				truncated: hasMore,
			};
		}

		const lineRegex = yield* compileRegex(
			params.literal === true ? escapeRegExp(params.query) : params.query,
			ignoreCase ? "i" : "",
		);
		const globalRegex = yield* compileRegex(
			params.literal === true ? escapeRegExp(params.query) : params.query,
			`${ignoreCase ? "i" : ""}${params.multiline === true ? "s" : ""}g`,
		);

		const flattened: { readonly path: string; readonly entry: MatchEntry }[] = [];
		const target = offset + limit + 1;
		for (const path of ordered) {
			if (flattened.length >= target) break;
			const stat2 = yield* fs.stat(path).pipe(Effect.orElseSucceed(() => undefined));
			if (stat2 !== undefined && stat2.isFile && stat2.size !== undefined && stat2.size > MAX_FILE_BYTES) continue;
			if (params.include !== undefined && params.include !== "" && !matchesPath(path, params.include, false))
				continue;
			const text = yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => undefined));
			if (text === undefined || text.includes("\0")) continue;
			const lines = text.split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			for (const entry of matchLines(lines, lineRegex, globalRegex, params.multiline === true, context)) {
				flattened.push({ path, entry });
			}
		}

		const selected = flattened.slice(offset, offset + limit);
		const hasMore = flattened.length > offset + selected.length;
		const grouped = groupEntries(selected);
		return {
			content: describeMatches(grouped, selected.length, hasMore, offset, "walk"),
			matches: selected.length,
			files: grouped.length,
			hasMore,
			truncated: hasMore,
		};
	});

export const searchHandler: Tool.Handler<
	typeof SearchParams,
	typeof SearchSuccess,
	typeof SearchFailure,
	SandboxIO.FileSystem | ToolShell
> = (params) =>
	Effect.gen(function* () {
		if (params.query.trim() === "") {
			return yield* new SearchFailed({
				query: params.query,
				reason: "invalid_pattern",
				message: "query cannot be empty.",
			});
		}
		const mode = params.mode ?? "content";
		const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
		const offset = params.offset ?? 0;
		const context = params.context ?? DEFAULT_CONTEXT;

		const shell = yield* ToolShell;
		const fs = yield* SandboxIO.FileSystem;
		const execArgv = shell.execArgv;
		const backend = yield* probeBackend(execArgv);

		const raw =
			backend === "ripgrep" && execArgv !== undefined
				? mode === "files"
					? yield* runRipgrepFiles(execArgv, params, limit, offset)
					: yield* runRipgrepContent(execArgv, params, limit, offset, context)
				: yield* runWalk(fs, params, mode, limit, offset, context);

		// A single match line can be huge; keep the report inside the shared byte cap.
		const bounded = truncateHead(raw.content, { maxBytes: DEFAULT_MAX_BYTES });
		const content = bounded.truncated
			? `${bounded.content}\n\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)}.]`
			: raw.content;

		return {
			content,
			matches: raw.matches,
			files: raw.files,
			truncated: raw.truncated || bounded.truncated,
			hasMore: raw.hasMore,
			backend,
		} satisfies typeof SearchSuccess.Type;
	});

export const searchTool = Tool.implement(searchDef, searchHandler);

export const searchPlugin = define({
	id: "codework.tool.search",
	kind: "tool",
	setup: Effect.fn("SearchPlugin.setup")(function* (ctx) {
		const fs = yield* SandboxIO.FileSystem;
		const shell = yield* SandboxIO.Shell;
		const toolShell = fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxIO.Shell, shell)));
		ctx.plugin.tools.add(Tool.provide(searchTool, Layer.merge(Layer.succeed(SandboxIO.FileSystem, fs), toolShell)));
	}),
});
