/**
 * The `mcpservers` prompt section: the servers whose tools are not declared to the model, since
 * the tool search does not list them. Only `deferred` tools have a way in: a server whose tools are
 * all `codemode` is left out until codemode exists, and the section is left out while the tool search
 * is not declared.
 */

import { ToolSearch } from "../tool/search.ts";
import { namespace } from "./config.ts";

export const name = "mcpservers";

/** Characters of a server description, as Codex allows for deferred namespaces. */
const MAX_DESCRIPTION_CHARS = 250;
/** Descriptions shrink to fit; when the server lines alone do not, the last servers are counted instead. */
const MAX_SECTION_CHARS = 4096;

const INTRO = `MCP servers whose tools are not declared to you. Load the tools of \`${ToolSearch.name}\` servers with \`${ToolSearch.name}\`.`;

/** An enabled server with deferred tools. */
export interface Listing {
	readonly name: string;
	readonly description: string | undefined;
	/** The server's instructions, once it connected. */
	readonly instructions: string | undefined;
}

const truncate = (text: string, max: number) =>
	text.length <= max ? text : max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;

/** First line of the configured description, or of the server instructions once connected. */
const summary = (server: Listing) => {
	const text = server.description?.trim() || server.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
};

/** Undefined when there are no servers. */
export const render = (servers: ReadonlyArray<Listing>): string | undefined => {
	const listed = [...servers].sort((a, b) => a.name.localeCompare(b.name));
	if (listed.length === 0) return undefined;
	const heads = listed.map((server) => `- ${namespace(server.name)} (${ToolSearch.name})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with ${ToolSearch.name}`] : [];
	const size = (kept: number) => [INTRO, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const each =
		kept === 0 ? 0 : Math.min(MAX_DESCRIPTION_CHARS, Math.floor((MAX_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const text = each > 0 ? truncate(summary(server), each) : "";
		return text ? `${heads[index]}: ${text}` : heads[index];
	});
	return [INTRO, ...lines, ...omitted(listed.length - kept)].join("\n");
};

export * as McpSection from "./section.ts";
