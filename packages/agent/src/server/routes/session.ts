import { lazy } from "@codeworksh/utils";
import { Value } from "@sinclair/typebox/value";
import { H3, HTTPError, readBody } from "h3";
import { Session } from "../../session/session.ts";
import { OpenAPI } from "../openapi.ts";

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

export const SessionRoutes: () => H3 = lazy(() => {
	const app = new H3();

	OpenAPI.route(
		app,
		{
			method: "POST",
			route: "/",
			path: "/sessions",
			tags: ["Sessions"],
			summary: "Create session",
			description: "Create a new Codework session for interacting with AI assistants and managing conversations.",
			operationId: "session.create",
			requestBody: {
				required: false,
				schema: Session.create.schema,
			},
			responses: {
				201: {
					description: "Successfully created session",
					schema: Session.Info,
				},
				400: {
					description: "Invalid session create request body",
				},
			},
		},
		async (event) => {
			const input = parseCreateInput(event.req.body ? await readBody(event) : undefined);
			const session = Session.create(input);
			event.res.status = 201;
			return session;
		},
	);

	return app;
});
