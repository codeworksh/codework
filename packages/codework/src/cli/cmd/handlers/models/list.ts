import { Model } from "@codeworksh/aikit";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.models,
	Effect.fn("CLI.models.list")(function* ({ provider }) {
		if (Option.isSome(provider)) {
			const models = yield* Effect.promise(() => Model.getModels(provider.value));
			const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
			yield* writeOut(sorted.map((m) => `${provider.value}/${m.id}\n`).join(""));
			return;
		}

		const catalog = yield* Effect.promise(() => Model.getBuiltInModels());
		const lines: string[] = [];
		const providers = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
		for (const providerId of providers) {
			const providerModels = Object.keys(catalog[providerId] ?? {}).sort((a, b) => a.localeCompare(b));
			for (const modelId of providerModels) {
				lines.push(`${providerId}/${modelId}\n`);
			}
		}
		yield* writeOut(lines.join(""));
	}),
);
