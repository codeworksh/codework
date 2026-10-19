import { Effect, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { ModelCatalog } from "../src/model/catalog.ts";
import { it } from "./utils/effect.ts";

/** A models.dev snapshot with one provider aikit keeps; with an empty OpenRouter listing, a refresh never touches the network. */
const modelsDev = {
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		env: ["ANTHROPIC_API_KEY"],
		npm: "@ai-sdk/anthropic",
		models: {
			"claude-test": {
				id: "claude-test",
				name: "Claude Test",
				family: "claude",
				attachment: true,
				tool_call: true,
				release_date: "2026-01-01",
				last_updated: "2026-01-01",
				modalities: { input: ["text"], output: ["text"] },
				open_weights: false,
			},
		},
	},
};

describe("ModelCatalog", () => {
	const saved = {
		file: process.env.CODEWORK_MODELS_FILE,
		dev: process.env.CODEWORK_MODELS_DEV_FILE,
		openRouter: process.env.CODEWORK_OPENROUTER_MODELS_FILE,
	};
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "codework-catalog-"));
		const snapshot = join(home, "modelsdev.json");
		writeFileSync(snapshot, JSON.stringify(modelsDev));
		process.env.CODEWORK_MODELS_DEV_FILE = snapshot;
		const listing = join(home, "openrouter.json");
		writeFileSync(listing, JSON.stringify({ data: [] }));
		process.env.CODEWORK_OPENROUTER_MODELS_FILE = listing;
		Reflect.deleteProperty(process.env, "CODEWORK_MODELS_FILE");
	});

	afterEach(() => {
		for (const [key, value] of [
			["CODEWORK_MODELS_FILE", saved.file],
			["CODEWORK_MODELS_DEV_FILE", saved.dev],
			["CODEWORK_OPENROUTER_MODELS_FILE", saved.openRouter],
		] as const) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});

	it.live("leaves a pinned catalog alone on the automatic check", () =>
		Effect.gen(function* () {
			const pinned = join(home, "pinned.json");
			process.env.CODEWORK_MODELS_FILE = pinned;
			expect(yield* ModelCatalog.sync(home)).toBe(pinned);
			expect(existsSync(pinned)).toBe(false);
			expect(existsSync(join(home, "models.gen.json"))).toBe(false);
			// Nothing to read yet: aikit's bundled baseline stands in.
			expect(yield* ModelCatalog.providers).toEqual(["anthropic", "openai", "openrouter"]);
		}),
	);

	it.effect("reloads the catalog a watching layer sees change on disk", () =>
		Effect.gen(function* () {
			const pinned = join(home, "pinned.json");
			process.env.CODEWORK_MODELS_FILE = pinned;
			writeFileSync(pinned, JSON.stringify({ anthropic: {} }));
			yield* Layer.build(ModelCatalog.layer({ home, watch: true }));
			expect(yield* ModelCatalog.providers).toEqual(["anthropic", "openai", "openrouter"]);

			writeFileSync(pinned, JSON.stringify({ anthropic: {}, xai: {} }));
			const later = new Date(Date.now() + 60_000);
			utimesSync(pinned, later, later);
			expect(yield* ModelCatalog.providers).toEqual(["anthropic", "openai", "openrouter"]);

			yield* TestClock.adjust("1 minute");
			// The tick stats the real file, so give that I/O a moment to land.
			for (let attempt = 0; attempt < 50; attempt++) {
				if ((yield* ModelCatalog.providers).length === 4) break;
				yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
			}
			expect(yield* ModelCatalog.providers).toEqual(["anthropic", "openai", "openrouter", "xai"]);
		}),
	);
});
