import { join, resolve } from "node:path";
import Type, { type Static } from "typebox";
import { NamedError } from "../utils/error.ts";
import * as Filesystem from "../utils/filesystem.ts";
import { lazy } from "../utils/lazy.ts";
import bundled from "./baseline.json" with { type: "json" };

// known AI SDK LLM providers
// used as the public protocol discriminator for the AI SDK transport layer
export const KnownProviderEnum = {
	anthropic: "anthropic",
	google: "google",
	googleVertex: "google-vertex",
	googleVertexAnthropic: "google-vertex-anthropic",
	githubCopilot: "github-copilot",
	openai: "openai",
	openaiCompatible: "openai-compatible",
	openaiCodex: "openai-codex",
	openrouter: "openrouter",
	xai: "xai",
} as const;
export const KnownProviderEnumSchema = Type.Union([
	Type.Literal(KnownProviderEnum.anthropic),
	Type.Literal(KnownProviderEnum.google),
	Type.Literal(KnownProviderEnum.googleVertex),
	Type.Literal(KnownProviderEnum.googleVertexAnthropic),
	Type.Literal(KnownProviderEnum.githubCopilot),
	Type.Literal(KnownProviderEnum.openai),
	Type.Literal(KnownProviderEnum.openaiCompatible),
	Type.Literal(KnownProviderEnum.openaiCodex),
	Type.Literal(KnownProviderEnum.openrouter),
	Type.Literal(KnownProviderEnum.xai),
]);
export type KnownProviderEnum = Static<typeof KnownProviderEnumSchema>;

export type GeneratedCatalog = Partial<Record<string, Record<string, unknown>>>;
type LazyGeneratedCatalog = ReturnType<typeof lazy<Promise<GeneratedCatalog>>>;

export const ModelCatalogLoadError = NamedError.create(
	"ModelCatalogLoadError",
	Type.Object({
		path: Type.String(),
		reason: Type.Union([Type.Literal("unreadable"), Type.Literal("empty"), Type.Literal("invalid")]),
		message: Type.String(),
	}),
);
export type ModelCatalogLoadError = InstanceType<typeof ModelCatalogLoadError>;

export function projectRoot(): string {
	return process.cwd();
}

export const filename = "models.gen.json";

let configured: string | undefined;

/**
 * Read the catalog from `catalogPath` instead of `./models.gen.json`, for an
 * embedder that keeps it elsewhere. `CODEWORK_MODELS_FILE` still wins.
 */
export function configure(catalogPath: string): void {
	configured = resolve(catalogPath);
	data.reset();
}

export function path(): string {
	return resolve(process.env.CODEWORK_MODELS_FILE ?? configured ?? join(projectRoot(), filename));
}

/**
 * The catalog bundled with aikit for OpenAI, Anthropic and OpenRouter (`aikit modelgen --baseline`),
 * so a first run works before any catalog was generated.
 */
export const baseline: GeneratedCatalog = bundled;

/**
 * The catalog at `catalogPath` over the {@link baseline}: a provider the file lists replaces the
 * bundled one, so a fresh generated catalog wins and an older one still gets the bundled providers.
 * A missing file reads as the baseline alone.
 */
export async function load(catalogPath = path()): Promise<GeneratedCatalog> {
	let content: string;
	try {
		content = await Filesystem.readText(catalogPath);
	} catch (cause) {
		const value =
			typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
				? cause.code
				: undefined;
		if (value === "ENOENT") return { ...baseline };
		throw new ModelCatalogLoadError(
			{ path: catalogPath, reason: "unreadable", message: `model catalog could not be read at ${catalogPath}` },
			{ cause },
		);
	}
	if (!content.trim()) {
		throw new ModelCatalogLoadError({
			path: catalogPath,
			reason: "empty",
			message: `model catalog is empty at ${catalogPath}`,
		});
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
		return { ...baseline, ...(parsed as GeneratedCatalog) };
	} catch (cause) {
		throw new ModelCatalogLoadError(
			{
				path: catalogPath,
				reason: "invalid",
				message: `model catalog contains invalid json at ${catalogPath}`,
			},
			{ cause },
		);
	}
}

export const data: LazyGeneratedCatalog = lazy(() => load());

export async function get(): Promise<GeneratedCatalog> {
	return data();
}
