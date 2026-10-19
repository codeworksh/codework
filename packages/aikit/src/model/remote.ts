/*
 * @file The published model catalog, downloaded.
 *
 * CI publishes what `aikit modelgen` builds to https://catalog.codework.sh/v1/models.json
 * (`.github/workflows/catalog.yml`). A client keeps the bytes it downloaded beside its catalog and
 * asks with their MD5, R2's ETag for them, so an unchanged catalog costs a 304. OpenRouter is
 * narrowed to the caller's key after download, which is why those bytes are kept apart from the
 * catalog the client reads.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Filesystem from "../utils/filesystem.ts";
import * as Model from "./model.ts";
import { OpenRouter } from "./openrouter.ts";

const DEFAULT_URL = "https://catalog.codework.sh/v1/models.json";
/** The downloaded bytes, kept beside the catalog for the next conditional request. */
const DOWNLOAD_FILENAME = "models.download.json";

/** The published catalog; `CODEWORK_CATALOG_URL` points elsewhere, a `file:` URL at a local copy. */
export function catalogURL(): string {
	return process.env.CODEWORK_CATALOG_URL || DEFAULT_URL;
}

/** The catalog's bytes: `previous` again when the server says they have not changed. */
async function fetchCatalog(url: string, previous: Buffer | undefined): Promise<Buffer> {
	if (url.startsWith("file:")) return readFile(fileURLToPath(url));
	const etag = previous ? `"${createHash("md5").update(previous).digest("hex")}"` : undefined;
	const response = await fetch(url, {
		headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 304 && previous) return previous;
	if (!response.ok) throw new Error(`model catalog responded ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

const knownProtocols: ReadonlySet<string> = new Set(Object.values(Model.KnownProviderEnum));
const knownMethods: ReadonlySet<string> = new Set(Object.values(Model.APIMethodEnum));

/**
 * Whether this aikit can call the model. A catalog published by a newer aikit can name a protocol
 * or API method this one does not know; such a model is left out rather than failing at call time.
 */
function callable(model: Model.Info): boolean {
	return knownProtocols.has(model.protocol) && (model.api?.method === undefined || knownMethods.has(model.api.method));
}

/**
 * Download the published catalog to `path`, narrowing OpenRouter to the models `openRouterKey` may
 * use. A failed download throws and leaves `path` as it was.
 */
export async function downloadCatalog(options: {
	readonly path: string;
	readonly url?: string | undefined;
	readonly openRouterKey?: string | undefined;
}): Promise<string> {
	const path = resolve(options.path);
	const downloaded = join(dirname(path), DOWNLOAD_FILENAME);
	const previous = await readFile(downloaded).catch(() => undefined);
	const bytes = await fetchCatalog(options.url ?? catalogURL(), previous);

	const parsed: unknown = JSON.parse(bytes.toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("model catalog is not a JSON object");
	}
	if (bytes !== previous) await Filesystem.writeAtomic(downloaded, bytes);

	const catalog: Model.BuiltInModels = {};
	for (const [provider, models] of Object.entries(parsed as Model.BuiltInModels)) {
		catalog[provider] = Object.fromEntries(Object.entries(models ?? {}).filter(([, model]) => callable(model)));
	}
	const openrouter = catalog[OpenRouter.PROVIDER_ID];
	if (options.openRouterKey && openrouter) {
		// The shared listing still beats none when OpenRouter cannot say what the key may use.
		catalog[OpenRouter.PROVIDER_ID] = await OpenRouter.personalize(openrouter, options.openRouterKey).catch(
			() => openrouter,
		);
	}
	await Filesystem.writeJsonAtomic(path, catalog);
	return path;
}
