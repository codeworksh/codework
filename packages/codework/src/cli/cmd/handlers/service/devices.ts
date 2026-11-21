import { DateTime, Effect } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Client from "../../../../server/client.ts";
import { reportFailure } from "../../../error.ts";
import { table, writeOut } from "../../../output.ts";
import * as Service from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

const time = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d+Z$/, "Z");

export default Runtime.handler(
	Cmd.commands.service.commands.devices,
	Effect.fn("CLI.service.devices")(function* () {
		const devices = yield* Effect.flatMap(Client.make, (rpc) => rpc["device.list"]({})).pipe(Service.connect());
		if (devices.length === 0) return yield* writeOut("No paired devices.\n");
		yield* writeOut(
			table([
				["ID", "LABEL", "CREATED", "LAST SEEN", "ENCRYPTED"],
				...devices.map((device) => [
					device.id,
					device.label,
					time(device.createdAt),
					time(device.seenAt),
					device.encrypted === undefined ? "-" : device.encrypted ? "yes" : "no",
				]),
			]),
		);
	}, Effect.catch(reportFailure)),
);
