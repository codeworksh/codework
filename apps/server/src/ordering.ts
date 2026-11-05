import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/*
 * Manual order on threads and groups, per organization. Fractional, so a move writes one row:
 * between two neighbours is their midpoint, first is the lowest minus one, last the highest plus one.
 */

export type Table = "thread" | "grouping";

/** The value that puts a row first or last among its organization's `table` rows. */
export const edge = (table: Table, organizationId: string, end: "first" | "last") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const value =
			end === "first"
				? sql.literal("COALESCE(MIN(ordering), 1) - 1")
				: sql.literal("COALESCE(MAX(ordering), -1) + 1");
		const [row] = yield* sql<{ ordering: number }>`
			SELECT ${value} AS ordering FROM ${sql(table)} WHERE organization_id = ${organizationId}
		`;
		return row?.ordering ?? 0;
	});

export const midpoint = (after: number, before: number) => (after + before) / 2;

export * as Ordering from "./ordering.ts";
