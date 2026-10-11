import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Discovery } from "../../../../server/discovery.ts";
import { reportFailure } from "../../../error.ts";
import { Service } from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.stop,
	Effect.fn("CLI.service.stop")(function* () {
		const paths = yield* Service.home(yield* Cmd.spec);
		yield* Discovery.stop(paths.home);
	}, Effect.catch(reportFailure)),
);
