import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/storage/schema.ts",
	out: "./migrations",
	dialect: "sqlite",
	migrations: {
		prefix: "index",
	},
});
