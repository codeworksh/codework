import { Layer } from "effect";
import * as ModelCatalog from "../../src/model/catalog.ts";
import type { Info } from "../../src/settings/schema.ts";
import * as Settings from "../../src/settings/settings.ts";

/** The model tests run: settings must name one, as no provider is configured in a test. */
export const testModel = { provider: "openai", id: "gpt-5.6-luna" } as const;

/** The built-in settings with {@link testModel} named, for tests that stub settings rather than read files. */
export const named: Info = { ...Settings.defaults, model: { ...Settings.defaults.model, ...testModel } };

/** No stored logins: a test that names no model reaches the catalog through the environment only. */
export const credentials = Layer.succeed(ModelCatalog.Credentials, { authFile: "/unused/home/aikit/auth.json" });
