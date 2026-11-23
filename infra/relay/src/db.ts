import { PgClient } from "@effect/sql-pg";
import { Config, String as Str } from "effect";
import { Migrator } from "effect/sql";
import { migrations } from "./migrations.ts";

/** The relay's Postgres, from `DATABASE_URL`; camelCase fields map to snake_case columns. */
export const layer = PgClient.layerConfig({
	url: Config.Redacted("DATABASE_URL"),
	transformQueryNames: Config.succeed(Str.camelToSnake),
	transformResultNames: Config.succeed(Str.snakeToCamel),
});

/** Applies pending migrations. The generic migrator needs only the client, not `pg_dump`. */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(migrations) });
