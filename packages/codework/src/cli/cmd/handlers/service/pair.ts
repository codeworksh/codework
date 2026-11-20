import { Effect } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Client from "../../../../server/client.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import * as Service from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.pair,
	Effect.fn("CLI.service.pair")(function* () {
		const { code } = yield* Effect.flatMap(Client.make, (rpc) => rpc["device.pair"]({})).pipe(Service.connect());
		yield* writeOut(`${code}\n`);
	}, Effect.catch(reportFailure)),
);
