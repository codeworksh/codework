import { Effect } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Client from "../../../../server/client.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import * as Service from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.revoke,
	Effect.fn("CLI.service.revoke")(function* ({ id }) {
		const { applied } = yield* Effect.flatMap(Client.make, (rpc) => rpc["device.revoke"]({ id })).pipe(
			Service.connect(),
		);
		if (!applied) return yield* new InvalidInputError({ message: `no paired device ${id}` });
	}, Effect.catch(reportFailure)),
);
