/*
 * @file A spec string becomes a Target. Pure: no I/O, no network.
 *
 * Every form a person can write is parsed by `npm-package-arg`, so the grammar is npm's rather
 * than ours, and every spec npa accepts is one the installer handles -- including `::path:`
 * subdirectories.
 *
 * Parse owns three rules and nothing else:
 *
 * 1. **`mutable`** -- whether re-resolving could produce different bytes. An exact version and a
 *    commit SHA name one artifact; a range, tag or branch names a moving target. It decides
 *    whether `check` and `update` have anything to do, and it is the only thing that justifies a
 *    network call.
 * 2. **`spec` canonical** -- `@acme/x` and `@acme/x@latest` become one string before anything
 *    hashes them, or they file as two directories holding identical bytes.
 * 3. **Explicit rejection** -- a spec that reaches the store is already known to be installable.
 *    Remote tarballs are unversioned, unauthenticated and have no update story; npa parses them,
 *    so the refusal has to be written down.
 */

import { Effect } from "effect";
import npa from "npm-package-arg";
import { fileURLToPath } from "node:url";
import { hostPath as path } from "../host.ts";
import { expandTilde } from "../util/home.ts";
import { SourceError } from "./error.ts";

export type Target =
	/** Files already on disk. Never fetched, never copied into the store. */
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "registry"; readonly name: string; readonly spec: string; readonly mutable: boolean }
	| {
			readonly kind: "git";
			readonly slug: string;
			readonly spec: string;
			readonly committish?: string;
			readonly subdir?: string;
			readonly mutable: boolean;
	  };

/** Only a fetched target has a store entry; a local one is loaded where it lies. */
export type Fetchable = Exclude<Target, { kind: "local" }>;

/** A committish that names one artifact rather than a moving branch: an unabbreviated SHA. */
const isCommit = (committish: string | null | undefined): boolean =>
	typeof committish === "string" && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(committish);

/**
 * A short, readable name for a git source, used to make a store path recognisable to a human
 * reading `ls`. It is never an identity: two remotes can slug alike, and the digest is what
 * separates them.
 */
export const slug = (spec: string): string => {
	const withoutCommittish = spec.split("#")[0] ?? spec;
	const decoded = (() => {
		try {
			return decodeURIComponent(withoutCommittish);
		} catch {
			return withoutCommittish;
		}
	})();
	return (
		decoded
			.replace(/\.git$/i, "")
			.split(/[/:\\]/)
			.at(-1)
			?.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "repository"
	);
};

/** Whether a reference names a place on disk rather than something to fetch. */
const isPath = (reference: string): boolean =>
	reference.startsWith("file:") ||
	reference.startsWith("./") ||
	reference.startsWith("../") ||
	path.isAbsolute(reference);

/**
 * `from` is the directory a relative spec resolves against, and the caller picks it:
 *
 * - a **plugin entry** anchors to the directory holding the file that declared it --
 *   `<root>/.codework/` for a project entry, `<home>/` for a user one, the named directory for
 *   `--user-config-dir`. The rule is about the file, not the project.
 * - a **CLI argument** anchors to the process's startup directory, because that is where the
 *   person typed it.
 */
export const parse = (reference: string, from: string): Effect.Effect<Target, SourceError> =>
	Effect.gen(function* () {
		const fail = (reason: SourceError["reason"], message: string) => new SourceError({ reason, reference, message });

		if (reference.startsWith("file:")) {
			// Both `new URL` and `fileURLToPath` silently read a relative `file:./x` as `/x`. A
			// file URL names an absolute path or it is not one.
			if (!reference.startsWith("file:///")) {
				return yield* fail("plugin-unsupported-source", `not an absolute file URL: ${reference}`);
			}
			return { kind: "local", path: fileURLToPath(reference) } as const;
		}

		// `~` before anything npa sees: npm names cannot start with it, and npa would read `~` as
		// a package and `~/x` as an unsupported spec, reporting a path as a bad package name.
		const expanded = expandTilde(reference, path);
		if (isPath(expanded)) return { kind: "local", path: path.resolve(from, expanded) } as const;

		const parsed = yield* Effect.try({
			try: () => npa(reference),
			catch: () => fail("plugin-unsupported-source", `cannot parse plugin source: ${reference}`),
		});

		if (parsed.type === "git") {
			// npa sets `gitSubdir` from a `::path:` suffix, but `@types/npm-package-arg` has not
			// caught up with it. Narrowed to the one field rather than widened to `any`.
			const { gitSubdir } = parsed as { readonly gitSubdir?: string | undefined };
			return {
				kind: "git",
				slug: slug(reference),
				spec: reference,
				...(parsed.gitCommittish == null ? {} : { committish: parsed.gitCommittish }),
				...(gitSubdir == null ? {} : { subdir: gitSubdir }),
				mutable: !isCommit(parsed.gitCommittish),
			} as const;
		}

		if (parsed.name !== null && ["version", "range", "tag"].includes(parsed.type)) {
			// npa turns a trailing bare `@` into the `*` range, which would give "no version" a
			// second identity. An explicit `pkg@*` keeps its own meaning.
			const omitted = parsed.raw === parsed.name || parsed.raw === `${parsed.name}@`;
			return {
				kind: "registry",
				name: parsed.name,
				spec: `${parsed.name}@${omitted ? "latest" : parsed.rawSpec}`,
				mutable: parsed.type !== "version",
			} as const;
		}

		// Remote tarballs land here, on purpose.
		return yield* fail("plugin-unsupported-source", `unsupported plugin source: ${reference}`);
	});

/**
 * What two references must share to be the same plugin, without installing either.
 *
 * A local path is the file it resolves to; a package is its name, so `@acme/x@1` and `@acme/x@2`
 * are one package at two versions. Pure -- nothing is installed, imported or read.
 */
export const canonical = (target: Target): string => {
	switch (target.kind) {
		case "local":
			return target.path;
		case "registry":
			return target.name;
		case "git":
			return target.slug;
	}
};

export * as PluginSource from "./source.ts";
