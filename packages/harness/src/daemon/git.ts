/**
 * The builtin git daemon: keeps a space's working-tree summary current and serves its patches.
 *
 * Pushes `plugin.git.status` (branch, head, and each changed file with its line counts) after the
 * space is mounted, after each turn, and when a drain lets go; pulls are `diff`, one patch per
 * file. Like opencode's VCS service it pushes small and serves big: patches never go out on the
 * event stream. It publishes only when the summary changed.
 */
import { Daemon } from "@codeworksh/plugin/plugin";
import { quote } from "@codeworksh/plugin/sandbox/shell";
import { Effect, Schema } from "effect";
import * as EventList from "../event/list.ts";
import { EventSchema } from "../event/schema.ts";
import type { ISandboxExe } from "@codeworksh/plugin/sandbox/shell";

/** A read's patches past this many bytes are left out, file by file. */
export const MAX_PATCH_BYTES = 10_000_000;

/** Untracked files larger than this on disk are not read: one could crowd every other file out. */
export const MAX_UNTRACKED_FILE_BYTES = 5_000_000;

const FileStatus = Schema.Struct({
	file: Schema.String,
	status: Schema.Literals(["added", "deleted", "modified"]),
	additions: Schema.Int,
	deletions: Schema.Int,
});
export type FileStatus = typeof FileStatus.Type;

/** One space's working tree, or why it could not be read. */
export const Status = EventSchema.define({
	type: "plugin.git.status",
	schema: {
		spaceId: Schema.String,
		observedAt: Schema.Int,
		available: Schema.Boolean,
		/** Absent before the first commit. */
		head: Schema.optional(Schema.String),
		/** Absent on a detached HEAD. */
		branch: Schema.optional(Schema.String),
		files: Schema.Array(FileStatus),
		reason: Schema.optional(Schema.Literals(["not-a-repository", "git-missing", "failed"])),
		message: Schema.optional(Schema.String),
	},
});
export type Status = typeof Status.Type;

const FileDiff = Schema.Struct({
	file: Schema.String,
	/** Empty when the file was left out of the read; its counts are then the summary's. */
	patch: Schema.String,
	status: Schema.Literals(["added", "deleted", "modified"]),
	additions: Schema.Int,
	deletions: Schema.Int,
});
export type FileDiff = typeof FileDiff.Type;

export const DiffInput = Schema.Struct({
	/** Default: every changed file. */
	files: Schema.optional(Schema.Array(Schema.String)),
	/** Lines of context. Default: 3. */
	context: Schema.optional(Schema.Int),
});
export const DiffOutput = Schema.Struct({
	files: Schema.Array(FileDiff),
	/**
	 * Set when files were left out: past {@link MAX_PATCH_BYTES} ({@link MAX_CACHED_PATCH_BYTES} when
	 * `cached`) or {@link MAX_UNTRACKED_FILE_BYTES}, each with an empty patch, or untracked past
	 * {@link MAX_COUNTED_UNTRACKED}, not listed.
	 */
	truncated: Schema.optional(Schema.Literal(true)),
	/**
	 * Served from the patches read at the last change, because the space is not mounted and reading
	 * it now would wake a sandbox. As old as the last `plugin.git.status`.
	 */
	cached: Schema.optional(Schema.Literal(true)),
});
export type DiffOutput = typeof DiffOutput.Type;

/** A record of its own between {@link SUMMARY}'s NUL-separated sections: no status or numstat record is this. */
const SEPARATOR = "\u0001";

/**
 * Every script starts at the repository root, so every path is root-relative even for a space that
 * is a subfolder. `GIT_OPTIONAL_LOCKS=0` keeps a background read from taking the index lock an
 * agent's next `git add` needs; `GIT_LITERAL_PATHSPECS=1` makes a path with `*` or `:` name only
 * itself; `LC_ALL=C` keeps git's messages matchable.
 */
const PRELUDE = [
	"export GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 LC_ALL=C",
	"top=$(git rev-parse --show-toplevel) || exit $?",
	'cd "$top" || exit $?',
].join("\n");

/**
 * The patches kept per space for `diff` while it is not mounted, read on each refresh: a remote
 * space's diff is wanted after its run, when nothing holds it.
 */
export const MAX_CACHED_PATCH_BYTES = 1_000_000;

/**
 * A file's patch size guessed from its line counts (one hunk's context included), so a file that
 * cannot fit is not read. Erring large: past twice the cap the read is cut in git's order, and the
 * files after the cut are left out.
 */
const estimate = (file: FileStatus) => 150 + (file.additions + file.deletions + 6) * 55;

/**
 * Untracked files past this many get no line counts in the summary and no patch in a `diff` (which
 * then says `truncated`): each costs one git process.
 */
export const MAX_COUNTED_UNTRACKED = 200;

/** The commit to diff against: `HEAD`, or the empty tree before the first commit. */
const BASE = `base=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || git hash-object -t tree /dev/null)`;

/**
 * At most {@link MAX_COUNTED_UNTRACKED} untracked paths, NUL-separated and intact. NUL and newline
 * are swapped so `head` (and `grep`) can count whole names: a newline in a name never splits it.
 */
const untracked = (args: string, filter = "") =>
	`git -c core.quotepath=false ls-files -z -o --exclude-standard ${args} | tr '\\n\\0' '\\0\\n'${filter} | head -n ${MAX_COUNTED_UNTRACKED} | tr '\\n\\0' '\\0\\n'`;

/** Status, tracked line counts and untracked line counts in one exec, sections split by a {@link SEPARATOR} record. */
const SUMMARY = [
	PRELUDE,
	// A wholly untracked folder is one `dir/` entry, as git shows it by default: a run that fills one
	// with thousands of files must not turn every published summary into thousands of entries.
	"git -c core.quotepath=false status --porcelain=v2 -z --branch --untracked-files=normal --no-renames || exit $?",
	"printf '\\001\\000'",
	BASE,
	'git -c core.quotepath=false diff "$base" --numstat -z --no-renames || exit $?',
	"printf '\\001\\000'",
	// Listed the way status lists them, folders collapsed: only untracked files get line counts.
	`${untracked("--directory --no-empty-directory", " | grep -av '/$'")} | xargs -0 -n 1 git diff --no-index --numstat -z -- /dev/null 2>/dev/null`,
	"exit 0",
].join("\n");

type Counts = Map<string, { readonly additions: number; readonly deletions: number }>;

/** `added\tdeleted\tpath\0`, or `added\tdeleted\t\0from\0to\0` for a pair (an untracked file against /dev/null). */
const parseNumstat = (tokens: ReadonlyArray<string>): Counts => {
	const counts: Counts = new Map();
	for (let index = 0; index < tokens.length; index++) {
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[index] ?? "");
		if (match === null) continue;
		let path = match[3] ?? "";
		if (path === "") {
			path = tokens[index + 2] ?? "";
			index += 2;
		}
		counts.set(path, {
			additions: match[1] === "-" ? 0 : Number(match[1]),
			deletions: match[2] === "-" ? 0 : Number(match[2]),
		});
	}
	return counts;
};

const statusOf = (xy: string): FileStatus["status"] | undefined =>
	// Added to the index, then deleted from the tree: in neither HEAD nor the working tree.
	xy === "AD" ? undefined : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : "modified";

export interface Summary {
	readonly head?: string;
	readonly branch?: string;
	readonly files: ReadonlyArray<FileStatus>;
}

/** Parses {@link SUMMARY}'s output: porcelain v2 status, then tracked and untracked numstat. */
export const parseSummary = (stdout: string): Summary => {
	const records = stdout.split("\0");
	const first = records.indexOf(SEPARATOR);
	const second = first === -1 ? -1 : records.indexOf(SEPARATOR, first + 1);
	const status = first === -1 ? records : records.slice(0, first);
	const tracked = first === -1 ? [] : records.slice(first + 1, second === -1 ? undefined : second);
	const counts = new Map([...parseNumstat(tracked), ...parseNumstat(second === -1 ? [] : records.slice(second + 1))]);
	let head: string | undefined;
	let branch: string | undefined;
	const files: Array<FileStatus> = [];
	const add = (file: string, kind: FileStatus["status"] | undefined) => {
		if (kind !== undefined)
			files.push({ file, status: kind, ...(counts.get(file) ?? { additions: 0, deletions: 0 }) });
	};
	for (const entry of status) {
		if (entry.startsWith("# branch.oid ")) {
			const oid = entry.slice("# branch.oid ".length);
			head = oid === "(initial)" ? undefined : oid;
		} else if (entry.startsWith("# branch.head ")) {
			const name = entry.slice("# branch.head ".length);
			branch = name === "(detached)" ? undefined : name;
		} else if (entry.startsWith("1 ")) {
			// 1 XY sub mH mI mW hH hI path
			const fields = entry.split(" ");
			add(fields.slice(8).join(" "), statusOf(fields[1] ?? ""));
		} else if (entry.startsWith("u ")) {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			add(entry.split(" ").slice(10).join(" "), "modified");
		} else if (entry.startsWith("? ")) {
			// A wholly untracked folder (`dir/`) carries no line counts: its files are not read.
			add(entry.slice(2), "added");
		}
	}
	files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	// Left out rather than undefined: the event feed carries JSON, which has no undefined.
	return { ...(head === undefined ? {} : { head }), ...(branch === undefined ? {} : { branch }), files };
};

// Some remote shells deliver git's message on stdout rather than stderr: both are read.
const unavailable = (exitCode: number, output: string) =>
	({
		available: false as const,
		files: [],
		reason:
			exitCode === 127
				? ("git-missing" as const)
				: /not a git repository/i.test(output)
					? ("not-a-repository" as const)
					: ("failed" as const),
		message: output.trim() || `git exited ${exitCode}`,
	}) satisfies Omit<Status["data"], "spaceId" | "observedAt">;

const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

/** A path git C-quoted in a patch (`"b/with\ttab"`), as the name. With `core.quotepath=false` an octal escape is one byte. */
const unquote = (path: string) =>
	path.length >= 2 && path.startsWith('"') && path.endsWith('"')
		? path
				.slice(1, -1)
				.replace(/\\([0-7]{3}|.)/g, (_, escape: string) =>
					escape.length === 3 ? String.fromCharCode(Number.parseInt(escape, 8)) : (ESCAPES[escape] ?? escape),
				)
		: path;

const failed = (message: string) => ({ available: false as const, files: [], reason: "failed" as const, message });

/** Splits a combined patch into one entry per file. */
export const parsePatch = (patch: string): Array<FileDiff> => {
	const chunks = patch.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
	return chunks.map((chunk) => {
		const lines = chunk.split("\n");
		const plus = lines.find((line) => line.startsWith("+++ "));
		const minus = lines.find((line) => line.startsWith("--- "));
		const strip = (line: string | undefined, prefix: string) => {
			if (line === undefined || line.endsWith("/dev/null")) return undefined;
			const path = unquote(line.slice(4).replace(/\t$/, ""));
			return path.startsWith(prefix) ? path.slice(prefix.length) : path;
		};
		// A binary or mode-only change has no `---`/`+++` lines: its name is in the header.
		const quoted = /^diff --git ("(?:[^"\\]|\\.)*")/.exec(lines[0] ?? "")?.[1];
		const header =
			quoted === undefined
				? /^diff --git a\/(.*) b\//.exec(lines[0] ?? "")?.[1]
				: unquote(quoted).slice("a/".length);
		const file = strip(plus, "b/") ?? strip(minus, "a/") ?? header ?? "";
		let additions = 0;
		let deletions = 0;
		let inHunk = false;
		for (const line of lines) {
			if (line.startsWith("@@")) inHunk = true;
			else if (inHunk && line.startsWith("+")) additions++;
			else if (inHunk && line.startsWith("-")) deletions++;
		}
		const status: FileDiff["status"] = lines.some((line) => line.startsWith("new file mode"))
			? "added"
			: lines.some((line) => line.startsWith("deleted file mode"))
				? "deleted"
				: "modified";
		return { file, patch: chunk, status, additions, deletions };
	});
};

const diffScript = (input: typeof DiffInput.Type, limit: number) => {
	const context = Math.max(0, Math.floor(input.context ?? 3));
	const paths = input.files === undefined ? "" : ` -- ${input.files.map(quote).join(" ")}`;
	const flags = `--no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ --unified=${context}`;
	return [
		PRELUDE,
		BASE,
		// git's errors (a bad pathspec, an unreadable index) are said, not shown as no changes: the
		// pipeline below cannot report them. 1 means there are changes.
		`git diff "$base" --quiet --no-renames${paths}; rc=$?; [ "$rc" -le 1 ] || exit "$rc"`,
		"{",
		`git -c core.quotepath=false diff "$base" --no-renames ${flags}${paths}`,
		`${untracked(paths)} | xargs -0 -n 1 sh -c '[ "$(wc -c < "$1")" -le ${MAX_UNTRACKED_FILE_BYTES} ] && exec git -c core.quotepath=false diff --no-index ${flags} -- /dev/null "$1"' sh 2>/dev/null`,
		`} | head -c ${limit + 1}`,
		// Said after the patches, outside the byte cap: more untracked files than were read.
		`[ "$(git ls-files -z -o --exclude-standard${paths} | tr -cd '\\0' | head -c ${MAX_COUNTED_UNTRACKED + 1} | wc -c)" -gt ${MAX_COUNTED_UNTRACKED} ] && printf '${SEPARATOR}cut'`,
		"exit 0",
	].join("\n");
};

const run = (shell: ISandboxExe, script: string) => shell.exec(script);

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** git could not produce the patches (not a repository, git missing): said, not shown as no changes. */
export class DiffFailed extends Schema.TaggedError<DiffFailed>()("GitDiffFailed", { message: Schema.String }) {}

const isFolder = (file: string) => file.endsWith("/");

/** Matched like a pathspec: the file, or everything under a folder. */
const within = (file: string, path: string) => file === path || file.startsWith(`${path.replace(/\/$/, "")}/`);

const leftOut = (file: FileStatus): FileDiff => ({ ...file, patch: "" });

/**
 * The patches of `candidates`, the summary's files a read is for in its order (every file when the
 * summary is unknown), within `cap` bytes. A file that does not fit what is left gets an empty patch
 * and the rest still get theirs: guessed from its line counts it is not read at all, and what was
 * read is checked again. A listed file the read did not return (untracked and too large, or past a
 * cut) is left out too.
 */
const readPatches = (
	shell: ISandboxExe,
	input: typeof DiffInput.Type,
	candidates: ReadonlyArray<FileStatus> | undefined,
	cap: number,
) =>
	Effect.suspend(() => {
		let guessed = 0;
		const fit = new Set(
			candidates?.filter((file) => {
				// A file read alone is read: only what it really takes can keep it out.
				if (candidates.length === 1) return true;
				const size = estimate(file);
				if (guessed + size > cap) return false;
				guessed += size;
				return true;
			}),
		);
		if (candidates !== undefined && candidates.length > 0 && fit.size === 0)
			return Effect.succeed<DiffOutput>({ files: candidates.map(leftOut), truncated: true });
		const paths =
			candidates === undefined || fit.size === candidates.length ? input.files : [...fit].map((file) => file.file);
		const limit = cap * 2;
		return run(shell, diffScript({ ...input, files: paths }, limit)).pipe(
			Effect.filterOrFail(
				(result) => result.exitCode === 0,
				(result) =>
					new DiffFailed({
						message: `${result.stderr}\n${result.stdout}`.trim() || `git exited ${result.exitCode}`,
					}),
			),
			Effect.map((result): DiffOutput => {
				const cut = result.stdout.endsWith(`${SEPARATOR}cut`);
				const stdout = cut ? result.stdout.slice(0, -`${SEPARATOR}cut`.length) : result.stdout;
				const read = parsePatch(stdout);
				// `head -c` counts bytes; so does this. A cut patch ends mid-file: that file is left out
				// rather than shown half.
				if (bytes(stdout) > limit) read.pop();
				let total = 0;
				const kept = (file: FileDiff) => {
					const size = bytes(file.patch);
					if (total + size > cap) return leftOut(file);
					total += size;
					return file;
				};
				const byFile = new Map(read.map((file) => [file.file, file]));
				const used = new Set<FileDiff>();
				const files: Array<FileDiff> = [];
				for (const entry of candidates ?? []) {
					if (!fit.has(entry)) {
						files.push(leftOut(entry));
						continue;
					}
					const exact = byFile.get(entry.file);
					const mine = isFolder(entry.file)
						? read.filter((file) => !used.has(file) && within(file.file, entry.file))
						: exact === undefined || used.has(exact)
							? []
							: [exact];
					for (const file of mine) used.add(file);
					files.push(...mine.map(kept));
					if (mine.length === 0 && !isFolder(entry.file)) files.push(leftOut(entry));
				}
				files.push(...read.filter((file) => !used.has(file)).map(kept));
				return cut || files.some((file) => file.patch === "") ? { files, truncated: true } : { files };
			}),
		);
	});

const keyOf = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const daemon = Daemon.define({
	id: "git",
	kind: "daemon",
	scope: "space",
	events: [Status],
	methods: { diff: { input: DiffInput, output: DiffOutput } },
	start: (ctx) =>
		Effect.gen(function* () {
			let last: string | undefined;
			let cached: DiffOutput | undefined;
			/** The files of the last summary, which size a read before it is made. */
			let known: ReadonlyArray<FileStatus> | undefined;
			const publish = (data: Omit<Status["data"], "spaceId" | "observedAt">) =>
				Effect.gen(function* () {
					const key = yield* keyOf(data).pipe(Effect.orDie);
					if (key === last) return;
					yield* ctx.events.publish(Status, data);
					last = key;
				});
			const summary = ctx.io
				.use(
					({ shell }) =>
						run(shell, SUMMARY).pipe(
							Effect.map((result) =>
								result.exitCode === 0
									? { available: true, ...parseSummary(result.stdout) }
									: unavailable(result.exitCode, `${result.stderr}\n${result.stdout}`),
							),
						),
					{ budget: "20 seconds" },
				)
				.pipe(
					// Said, not left stale: a repository too big to read in time, or a deleted folder, is a
					// state the client shows.
					Effect.catchTags({
						"Daemon.BudgetExceeded": (error) =>
							Effect.succeed(failed(`git did not answer within ${error.budget}`)),
						ShellError: (error) =>
							Effect.succeed(
								failed(
									error.cause instanceof Error
										? error.cause.message
										: `could not run git in ${ctx.space.location}`,
								),
							),
					}),
				);
			/**
			 * Read on every refresh, while the space is held, for a `diff` asked after it is let go: the
			 * same line counts can hide a different patch. Best effort; without a fresh read there is none.
			 */
			const keepPatches = (data: Omit<Status["data"], "spaceId" | "observedAt">) =>
				Effect.gen(function* () {
					known = data.available ? data.files : undefined;
					cached = data.available
						? yield* ctx.io
								.use(({ shell }) => readPatches(shell, {}, data.files, MAX_CACHED_PATCH_BYTES), {
									budget: "20 seconds",
								})
								.pipe(Effect.orElseSucceed(() => undefined))
						: undefined;
				});
			/** The summary's files a `diff` of `wanted` is for; one it does not list yet stands as itself. */
			const candidatesOf = (wanted: ReadonlyArray<string> | undefined) =>
				known === undefined || wanted === undefined
					? known
					: wanted.flatMap((path): ReadonlyArray<FileStatus> => {
							const listed = known?.filter((file) => within(file.file, path)) ?? [];
							return listed.length > 0
								? listed
								: [{ file: path, status: "modified", additions: 0, deletions: 0 }];
						});
			const refresh = summary.pipe(Effect.tap(publish), Effect.flatMap(keepPatches));
			const status = yield* ctx.work("status", refresh);
			yield* ctx.events.on(
				[EventList.SpaceMountAttached, EventList.TurnEnded, EventList.SpaceMountDetached],
				() => status.mark,
			);
			// A diff asked for is a look at the space: its summary is read again too, now if it is held (a
			// local space always is), else at its next mount.
			yield* ctx.handle("diff", (input) =>
				status.mark.pipe(
					Effect.andThen(
						ctx.io.use(({ shell }) => readPatches(shell, input, candidatesOf(input.files), MAX_PATCH_BYTES), {
							budget: "60 seconds",
						}),
					),
					Effect.catchTag("Daemon.Detached", (error) => {
						if (cached === undefined || (input.context ?? 3) !== 3) return Effect.fail(error);
						const wanted = input.files;
						const files =
							wanted === undefined
								? cached.files
								: cached.files.filter((file) => wanted.some((path) => within(file.file, path)));
						const truncated =
							files.some((file) => file.patch === "") || (wanted === undefined && cached.truncated);
						return Effect.succeed({
							files,
							cached: true as const,
							...(truncated ? { truncated: true as const } : {}),
						});
					}),
				),
			);
		}),
});
