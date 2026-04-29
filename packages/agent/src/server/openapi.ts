import type { TSchema } from "@sinclair/typebox";
import type { H3, HTTPHandler } from "h3";
import pkg from "../../package.json" with { type: "json" };

type OpenAPIMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type OpenAPIParameterLocation = "cookie" | "header" | "path" | "query";
type OpenAPIContentType = "application/json" | "text/plain";

type OpenAPISchema = TSchema | boolean;

type OpenAPIParameter = {
	name: string;
	in: OpenAPIParameterLocation;
	description?: string;
	required?: boolean;
	schema: OpenAPISchema;
};

type OpenAPIRequestBody = {
	description?: string;
	required?: boolean;
	contentType?: OpenAPIContentType;
	schema: OpenAPISchema;
};

type OpenAPIResponse = {
	description: string;
	contentType?: OpenAPIContentType;
	schema?: OpenAPISchema;
};

export type OpenAPIRoute = {
	method: OpenAPIMethod;
	route: string;
	path?: string;
	summary?: string;
	description?: string;
	operationId?: string;
	tags?: string[];
	parameters?: OpenAPIParameter[];
	requestBody?: OpenAPIRequestBody;
	responses: Record<number, OpenAPIResponse>;
};

type OpenAPIPathItem = Partial<Record<Lowercase<OpenAPIMethod>, unknown>>;

const routes: OpenAPIRoute[] = [];

function toOpenAPIPath(path: string) {
	return path.replace(/:([^/]+)/g, "{$1}");
}

function content(response: OpenAPIResponse) {
	if (!response.schema) return undefined;
	return {
		[response.contentType ?? "application/json"]: {
			schema: response.schema,
		},
	};
}

function requestBody(body: OpenAPIRequestBody) {
	return {
		description: body.description,
		required: body.required ?? false,
		content: {
			[body.contentType ?? "application/json"]: {
				schema: body.schema,
			},
		},
	};
}

function operation(route: OpenAPIRoute) {
	return {
		tags: route.tags,
		summary: route.summary,
		description: route.description,
		operationId: route.operationId,
		parameters: route.parameters,
		requestBody: route.requestBody ? requestBody(route.requestBody) : undefined,
		responses: Object.fromEntries(
			Object.entries(route.responses).map(([status, response]) => [
				status,
				{
					description: response.description,
					content: content(response),
				},
			]),
		),
	};
}

export namespace OpenAPI {
	export function route(app: H3, spec: OpenAPIRoute, handler: HTTPHandler): H3 {
		routes.push(spec);
		return app.on(spec.method, spec.route, handler, {
			meta: {
				openapi: spec,
			},
		});
	}

	export function document() {
		const paths: Record<string, OpenAPIPathItem> = {};

		for (const route of routes) {
			const path = toOpenAPIPath(route.path ?? route.route);
			const item = (paths[path] ??= {});
			item[route.method.toLowerCase() as Lowercase<OpenAPIMethod>] = operation(route);
		}

		return {
			openapi: "3.1.0",
			info: {
				title: "CodeWork Agent API",
				version: pkg.version,
			},
			paths,
		};
	}

	export function reset() {
		routes.length = 0;
	}
}
