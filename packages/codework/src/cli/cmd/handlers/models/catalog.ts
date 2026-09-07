import { Model } from "@codeworksh/aikit";
import { Runner } from "@codeworksh/harness/effect";
import { Effect } from "effect";

const catalogError = (cause: unknown): Runner.ModelCatalogError => {
	if (
		typeof cause === "object" &&
		cause !== null &&
		"name" in cause &&
		cause.name === "ModelCatalogLoadError" &&
		"data" in cause &&
		typeof cause.data === "object" &&
		cause.data !== null
	) {
		const data = cause.data;
		if (
			"path" in data &&
			typeof data.path === "string" &&
			"message" in data &&
			typeof data.message === "string" &&
			"reason" in data &&
			(data.reason === "missing" ||
				data.reason === "unreadable" ||
				data.reason === "empty" ||
				data.reason === "invalid")
		) {
			return new Runner.ModelCatalogError({
				path: data.path,
				reason: data.reason,
				detail: data.message,
			});
		}
	}
	return new Runner.ModelCatalogError({
		path: "",
		reason: "unreadable",
		detail: cause instanceof Error ? cause.message : "failed to load the model catalog",
	});
};

export const loadCatalog = Effect.tryPromise({
	try: () => Model.getBuiltInModels(),
	catch: catalogError,
});

export const loadProviders = Effect.tryPromise({
	try: () => Model.getProviders(),
	catch: catalogError,
});
