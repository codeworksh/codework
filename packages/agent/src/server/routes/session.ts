import { lazy } from "@codeworksh/utils";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getQuery, H3, HTTPError, readBody } from "h3";
import { Session } from "../../session/session.ts";
import { OpenAPI } from "../openapi.ts";

const ListQuery = Type.Object({
	directory: Type.Optional(Type.String({ description: "Filter sessions by project directory" })),
	workspaceId: Type.Optional(Type.String({ description: "Filter sessions by workspace ID" })),
	roots: Type.Optional(Type.Boolean({ description: "Only return root sessions (no parentID)" })),
	start: Type.Optional(
		Type.Number({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
	),
	search: Type.Optional(Type.String({ description: "Filter sessions by title (case-insensitive)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of sessions to return" })),
});
type ListQuery = Static<typeof ListQuery>;

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

function stringQueryValue(query: Record<string, unknown>, key: string) {
	const value = query[key];
	if (Array.isArray(value)) {
		if (value.length > 1) throw new Error(`query parameter "${key}" must be provided once`);
		return value[0];
	}
	return value;
}

function parseBooleanQuery(query: Record<string, unknown>, key: string) {
	const value = stringQueryValue(query, key);
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`query parameter "${key}" must be a boolean`);
}

function parseNumberQuery(query: Record<string, unknown>, key: string) {
	const value = stringQueryValue(query, key);
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`query parameter "${key}" must be a number`);
	return number;
}

function parseStringQuery(query: Record<string, unknown>, key: string) {
	const value = stringQueryValue(query, key);
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`query parameter "${key}" must be a string`);
	return value;
}

function parseListQuery(query: Record<string, unknown>): ListQuery {
	try {
		const input: ListQuery = {};
		const directory = parseStringQuery(query, "directory");
		const workspaceId = parseStringQuery(query, "workspaceId");
		const roots = parseBooleanQuery(query, "roots");
		const start = parseNumberQuery(query, "start");
		const search = parseStringQuery(query, "search");
		const limit = parseNumberQuery(query, "limit");

		if (directory !== undefined) input.directory = directory;
		if (workspaceId !== undefined) input.workspaceId = workspaceId;
		if (roots !== undefined) input.roots = roots;
		if (start !== undefined) input.start = start;
		if (search !== undefined) input.search = search;
		if (limit !== undefined) input.limit = limit;

		if (!Value.Check(ListQuery, input)) {
			throw new Error("query does not match session list schema");
		}
		return Value.Parse(ListQuery, input);
	} catch (cause) {
		throw HTTPError.status(400, "Bad Request", {
			cause,
			message: "Invalid session list query",
		});
	}
}

export const SessionRoutes: () => H3 = lazy(() => {
	const app = new H3();

	OpenAPI.route(
		app,
		{
			method: "GET",
			route: "/",
			path: "/sessions",
			tags: ["Session"],
			summary: "List sessions",
			description: "Get a list of all CodeWork sessions, sorted by most recently updated.",
			operationId: "session.list",
			parameters: [
				{
					name: "directory",
					in: "query",
					description: "Filter sessions by project directory",
					required: false,
					schema: Type.String(),
				},
				{
					name: "roots",
					in: "query",
					description: "Only return root sessions (no parentID)",
					required: false,
					schema: Type.Boolean(),
				},
				{
					name: "workspaceId",
					in: "query",
					description: "Filter sessions by workspace ID",
					required: false,
					schema: Type.String(),
				},
				{
					name: "start",
					in: "query",
					description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)",
					required: false,
					schema: Type.Number(),
				},
				{
					name: "search",
					in: "query",
					description: "Filter sessions by title (case-insensitive)",
					required: false,
					schema: Type.String(),
				},
				{
					name: "limit",
					in: "query",
					description: "Maximum number of sessions to return",
					required: false,
					schema: Type.Number(),
				},
			],
			responses: {
				200: {
					description: "List of sessions",
					schema: Type.Array(Session.Info),
				},
				400: {
					description: "Invalid session list query",
				},
			},
		},
		async (event) => {
			const query = parseListQuery(getQuery(event));
			const sessions: Session.Info[] = [];
			for await (const session of Session.list({
				directory: query.directory,
				workspaceId: query.workspaceId,
				roots: query.roots,
				start: query.start,
				search: query.search,
				limit: query.limit,
			})) {
				sessions.push(session);
			}
			return sessions;
		},
	);

	OpenAPI.route(
		app,
		{
			method: "POST",
			route: "/",
			path: "/sessions",
			tags: ["Session"],
			summary: "Create session",
			description: "Create a new CodeWork session for interacting with AI assistants and managing conversations.",
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
			const input = parseCreateInput(await readBody(event));
			const session = Session.create(input);
			event.res.status = 201;
			return session;
		},
	);

	return app;
});
