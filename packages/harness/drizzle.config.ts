import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/db/schema.sql.ts",
	out: "./migrations",
	dialect: "sqlite",
});
