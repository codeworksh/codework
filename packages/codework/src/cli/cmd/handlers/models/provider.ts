import { Model } from "@codeworksh/aikit";
import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.models.commands.provider,
	Effect.fn("CLI.models.provider")(function* () {
		const providers = yield* Effect.promise(() => Model.getProviders());
		const sorted = [...providers].sort((a, b) => a.localeCompare(b));
		yield* writeOut(sorted.map((p) => `${p}\n`).join(""));
	}),
);
