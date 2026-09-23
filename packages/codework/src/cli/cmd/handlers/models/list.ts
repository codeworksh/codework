import { ModelCatalog } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { synced } from "./catalog.ts";

export default Runtime.handler(
	Cmd.commands.models,
	Effect.fn("CLI.models.list")(function* ({ provider }) {
		const program = Effect.gen(function* () {
			yield* synced;
			const catalog = yield* ModelCatalog.models;
			if (Option.isSome(provider)) {
				const providerId = provider.value;
				if (!Object.hasOwn(catalog, providerId)) {
					return yield* new InvalidInputError({
						message: `provider "${providerId}" is not in the catalog\nhint: run \`codework models providers\``,
					});
				}
				const sorted = Object.keys(catalog[providerId] ?? {}).sort((a, b) => a.localeCompare(b));
				yield* writeOut(sorted.map((modelId) => `${providerId}/${modelId}\n`).join(""));
				return;
			}

			const lines: string[] = [];
			const providers = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
			for (const providerId of providers) {
				const providerModels = Object.keys(catalog[providerId] ?? {}).sort((a, b) => a.localeCompare(b));
				for (const modelId of providerModels) {
					lines.push(`${providerId}/${modelId}\n`);
				}
			}
			yield* writeOut(lines.join(""));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
