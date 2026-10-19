/*
 * Discovery happens only in the sandbox namespace, local or remote: never through the host
 * filesystem (`hostDir`, `hostCwd`) and never from a global `<home>` directory, so skills are
 * project-scoped. See `discover` for which directories are read.
 */

import * as Section from "@codeworksh/plugin/plugin/section";
import { Effect, Option } from "effect";
import ignore from "ignore";
import { parse as parseYaml } from "yaml";
import { Global } from "../../../global.ts";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxFs } from "../../../sandbox/fs/util.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { posix } from "../../../util/posix.ts";
import type { SharedPluginContext } from "../../context.ts";
import { define } from "../../plugin.ts";
import { ancestors, present, stripBom } from "./walk.ts";

/** Max name length per Agent Skills spec. */
const MAX_NAME_LENGTH = 64;

/** Max description length per Agent Skills spec. */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES: ReadonlyArray<string> = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

type SkillDiscoveryMode = "codework" | "agents";

interface Skill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly disableModelInvocation: boolean;
}

interface SkillFrontmatter {
	readonly name?: unknown;
	readonly description?: unknown;
	readonly "disable-model-invocation"?: unknown;
}

const normalizeNewlines = (value: string): string => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

const extractFrontmatter = (content: string): string | undefined => {
	const normalized = normalizeNewlines(stripBom(content));
	if (!normalized.startsWith("---")) return undefined;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return undefined;
	return normalized.slice(4, endIndex);
};

const parseFrontmatter = (raw: string): { readonly frontmatter: SkillFrontmatter; readonly error?: unknown } => {
	const yamlString = extractFrontmatter(raw);
	if (yamlString === undefined) return { frontmatter: {} };
	try {
		const parsed: unknown = parseYaml(yamlString);
		return {
			frontmatter:
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as SkillFrontmatter) : {},
		};
	} catch (error) {
		return { frontmatter: {}, error };
	}
};

const validateName = (name: string): string[] => {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push("name must not start or end with a hyphen");
	}
	if (name.includes("--")) {
		errors.push("name must not contain consecutive hyphens");
	}
	return errors;
};

const validateDescription = (description: unknown): string[] => {
	const errors: string[] = [];
	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
};

const prefixIgnorePattern = (line: string, prefix: string): string | undefined => {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return undefined;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
};

const addIgnoreRules = Effect.fnUntraced(function* (
	fs: SandboxFileSystem.Interface,
	ig: IgnoreMatcher,
	dir: string,
	root: string,
	entryNames: ReadonlySet<string>,
) {
	const relativeDir = posix.relative(root, dir);
	const prefix = relativeDir && relativeDir !== "." ? `${relativeDir}/` : "";
	const presentIgnoreFiles = IGNORE_FILE_NAMES.filter((name) => entryNames.has(name));
	if (presentIgnoreFiles.length === 0) return;

	const contents = yield* Effect.forEach(
		presentIgnoreFiles,
		(filename) => fs.readFile(posix.join(dir, filename)).pipe(Effect.option),
		{ concurrency: "unbounded" },
	);
	for (const content of contents) {
		if (Option.isNone(content)) continue;
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => line !== undefined);
		if (patterns.length > 0) ig.add(patterns);
	}
});

const loadSkillFromFile = Effect.fnUntraced(function* (fs: SandboxFileSystem.Interface, filePath: string) {
	const isDeclaredSkill = posix.basename(filePath) === "SKILL.md";
	const raw = yield* fs.readFile(filePath).pipe(
		Effect.tapError((error) => Effect.logWarning(`could not read skill file ${filePath}`, error.cause)),
		Effect.option,
	);
	if (Option.isNone(raw)) return undefined;

	const { frontmatter, error } = parseFrontmatter(raw.value);
	if (error !== undefined) {
		if (isDeclaredSkill) yield* Effect.logWarning(`could not parse skill file ${filePath}`, error);
		return undefined;
	}
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!isDeclaredSkill && !hasDescription) return undefined;

	const skillDir = posix.dirname(filePath);
	const parentDirName = posix.basename(skillDir);

	for (const error of validateDescription(description)) {
		yield* Effect.logWarning(`skill ${filePath}: ${error}`);
	}

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;

	for (const error of validateName(name)) {
		yield* Effect.logWarning(`skill ${filePath}: ${error}`);
	}

	if (!hasDescription) return undefined;

	return {
		name,
		description,
		filePath,
		baseDir: skillDir,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	} satisfies Skill;
});

const scanDir = (
	fs: SandboxFileSystem.Interface,
	dir: string,
	mode: SkillDiscoveryMode,
	root: string,
	ig: IgnoreMatcher,
	visited: ReadonlySet<string>,
): Effect.Effect<Skill[]> =>
	Effect.gen(function* () {
		const realDir = yield* SandboxFs.realpath(fs, dir);
		if (visited.has(realDir)) return [];
		const nextVisited = new Set([...visited, realDir]);

		const listed = yield* fs.readdir(dir).pipe(
			Effect.tapError((error) =>
				SandboxFileSystem.isNotFoundError(error.cause)
					? Effect.void
					: Effect.logWarning(`could not read skill directory ${dir}`, error.cause),
			),
			Effect.option,
		);
		if (Option.isNone(listed)) return [];

		const entries = [...listed.value].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const entrySet = new Set(entries);
		yield* addIgnoreRules(fs, ig, dir, root, entrySet);

		if (entrySet.has("SKILL.md")) {
			const fullPath = posix.join(dir, "SKILL.md");
			const relPath = posix.relative(root, fullPath);
			const isFile = yield* SandboxFs.isFile(fs, fullPath);
			if (isFile && !ig.ignores(relPath)) {
				const skill = yield* loadSkillFromFile(fs, fullPath);
				return skill === undefined ? [] : [skill];
			}
		}

		const visible = entries.filter((name) => !name.startsWith(".") && name !== "node_modules");
		const statted = yield* Effect.forEach(
			visible,
			(name) => {
				const fullPath = posix.join(dir, name);
				return fs.stat(fullPath).pipe(
					Effect.map((stat) => ({ name, fullPath, stat })),
					Effect.option,
				);
			},
			{ concurrency: "unbounded" },
		);

		const skills: Skill[] = [];
		for (const item of statted) {
			if (Option.isNone(item)) continue;
			const { name, fullPath, stat } = item.value;
			const relPath = posix.relative(root, fullPath);
			if (ig.ignores(stat.isDirectory ? `${relPath}/` : relPath)) continue;

			if (stat.isDirectory) {
				const nested = yield* scanDir(fs, fullPath, mode, root, ig, nextVisited);
				skills.push(...nested);
				continue;
			}

			const includeMarkdown =
				stat.isFile &&
				name.endsWith(".md") &&
				((mode === "codework" && dir === root) || (mode === "agents" && dir !== root));
			if (includeMarkdown) {
				const skill = yield* loadSkillFromFile(fs, fullPath);
				if (skill !== undefined) skills.push(skill);
			}
		}

		return skills;
	});

/**
 * Load skills from a single directory in the sandbox.
 *
 * Discovery rules:
 * - If a directory contains `SKILL.md`, treat it as a skill root and do not recurse further.
 * - In `"codework"` mode, direct `.md` children in the root are also loaded; in `"agents"` mode,
 *   `.md` files in subdirectories are loaded while root `.md` files are ignored.
 * - Recurse into subdirectories (skipping dotfiles, `node_modules`, and ignored paths).
 */
const loadSkillsFromDir = (
	fs: SandboxFileSystem.Interface,
	dir: string,
	mode: SkillDiscoveryMode,
): Effect.Effect<Skill[]> => scanDir(fs, dir, mode, dir, ignore(), new Set());

/**
 * Discover skills inside the sandbox: `.codework/skills` at the cwd, then
 * `.agents/skills` from the cwd up to the git root (the closest ancestor holding `.git`), or up to
 * the sandbox root outside a repository. Earlier skills win name collisions.
 */
export const discover = Effect.fnUntraced(function* (
	fs: SandboxFileSystem.Interface,
	location: SharedPluginContext["location"],
) {
	const chain = ancestors(location.directory);
	const own = posix.join(location.directory, Global.appConfigDir, "skills");
	const agents = chain.map((directory) => posix.join(directory, ".agents", "skills"));
	// One batch for every probe: on a remote sandbox each stat is a network round trip.
	const [dirs, gits] = yield* Effect.all(
		[
			present(fs, [own, ...agents], "directory", "skill directory"),
			present(
				fs,
				chain.map((directory) => posix.join(directory, ".git")),
				"entry",
				"git marker",
			),
		],
		{ concurrency: "unbounded" },
	);
	const root = chain.findIndex((directory) => gits.has(posix.join(directory, ".git")));
	const walked = root === -1 ? agents : agents.slice(0, root + 1);

	const sources = [
		{ dir: own, mode: "codework" as const },
		...walked.map((dir) => ({ dir, mode: "agents" as const })),
	].filter(({ dir }) => dirs.has(dir));
	const found = yield* Effect.forEach(sources, ({ dir, mode }) => loadSkillsFromDir(fs, dir, mode), {
		concurrency: "unbounded",
	});

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();

	for (const skill of found.flat()) {
		const realPath = yield* SandboxFs.realpath(fs, skill.filePath);
		if (realPathSet.has(realPath)) continue;

		const existing = skillMap.get(skill.name);
		if (existing !== undefined) {
			yield* Effect.logWarning(`skill ${skill.filePath}: name "${skill.name}" collision with ${existing.filePath}`);
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(realPath);
		}
	}

	return Array.from(skillMap.values());
});

const escapeXml = (str: string): string =>
	str
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

/**
 * Format skills for inclusion in `Section.Skills` per the Agent Skills specification.
 * Skills with `disableModelInvocation: true` are excluded from the prompt.
 */
const formatSkillsForPrompt = (
	skills: ReadonlyArray<Skill>,
	fileReadTool: "read" | "bash" | "indirect" = "read",
): string => {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: fileReadTool === "bash"
				? "Use bash to load a skill's file when the task matches its description."
				: "Load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
};

const readers = ["read", "bash"] as const;

export const skillPlugin = define({
	id: "codework.prompt.skill",
	kind: "prompt",
	setup: Effect.fn("SkillPlugin.setup")(function* (ctx) {
		const tools = ctx.plugin.tools;
		const visible = (name: string) => {
			const tool = tools.get(name);
			return tool !== undefined && tool.promptSnippet !== undefined && tool.promptSnippet.length > 0;
		};
		const fileReadTool = readers.find(visible) ?? (readers.some((name) => tools.has(name)) ? "indirect" : undefined);
		if (fileReadTool === undefined) return;

		const fs = yield* SandboxIO.FileSystem;
		const skills = yield* discover(fs, ctx.location);
		const formatted = formatSkillsForPrompt(skills, fileReadTool);
		if (formatted.length === 0) return;

		ctx.plugin.prompt.sections.append(Section.Skills, formatted);
	}),
});
