import { Schema } from "effect";

/*
 * @file What a plugin failure is called, for two audiences.
 *
 * The **tag** is for code. It begins `Plugin`, so it is greppable and cannot collide with a
 * sandbox or provider error of the same shape, and there is one per place a caller would
 * genuinely branch.
 *
 * The **reason** is for people and logs. Lowercase kebab, prefixed `plugin-`, and it is the exact
 * slug the CLI prints inside `error[...]`. The second prefix is not redundant with the first: a
 * tag appears in a stack trace, a reason appears alone in a log line where nothing else says which
 * subsystem produced it.
 *
 * Tag at the seams, reason at the leaves. A tag per failure mode would name every accident
 * precisely and leave twenty exported types for every `catchTag` to enumerate.
 *
 * Everything user-facing is lowercase -- reasons, messages, hints. A message is a fragment that
 * gets embedded in a line the CLI composes (`error[slug]: <message>`), so a leading capital is a
 * sentence opening that never comes. Names are the exception: package specs, IDs, file paths, env
 * vars and Node's own error codes keep whatever case they have, because they are quoted values
 * rather than words.
 */

/**
 * The reference as the person wrote it -- the string they will recognise in their settings file,
 * never the resolved path or the canonical spec. Every plugin failure carries one.
 */
const Reference = Schema.String;

/**
 * A spec that cannot be installed at all.
 *
 * `plugin-not-found` is a local path with nothing at it; `plugin-not-installed` (the store's) is a
 * package spec with no entry. The first is a mistake in a settings file, the second is fixed by
 * `plugin install`, and keeping them apart is most of the value of having slugs.
 */
export class SourceError extends Schema.TaggedError<SourceError>()("PluginSourceError", {
	reason: Schema.Literals(["plugin-unsupported-source", "plugin-not-found", "plugin-escapes-root"]),
	reference: Reference,
	message: Schema.String,
}) {}

/** A spec that is installable, and whose install did not produce a usable package. */
export class InstallError extends Schema.TaggedError<InstallError>()("PluginInstallError", {
	reason: Schema.Literals([
		"plugin-resolve-failed",
		"plugin-fetch-failed",
		"plugin-no-commit",
		"plugin-no-entrypoint",
	]),
	reference: Reference,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The store's own failures: what is filed, what is not, and what could not be claimed. */
export class StoreError extends Schema.TaggedError<StoreError>()("PluginStoreError", {
	reason: Schema.Literals([
		"plugin-not-installed",
		"plugin-lock-timeout",
		"plugin-marker-invalid",
		"plugin-index-invalid",
		"plugin-collect-failed",
	]),
	reference: Reference,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export * as PluginError from "./error.ts";
