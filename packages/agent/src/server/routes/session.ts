import { lazy } from "@codeworksh/utils";
import { Value } from "@sinclair/typebox/value";
import { H3, HTTPError, readBody } from "h3";
import { Session } from "../../session/session.ts";

function parseCreateInput(body: unknown) {
	const input = body === "" ? undefined : body;
	if (input === undefined) return undefined;
	try {
		if (!Value.Check(Session.create.schema, input)) {
			throw new Error("body does not match Session.create schema");
		}
		return Value.Parse(Session.create.schema, input);
	} catch (cause) {
		throw HTTPError.status(400, "Bad Request", {
			cause,
			message: "Invalid session create request body",
		});
	}
}

export const SessionRoutes: () => H3 = lazy(() =>
	new H3().post("/", async (event) => {
		const input = parseCreateInput(event.req.body ? await readBody(event) : undefined);
		return Session.create(input);
	}),
);
