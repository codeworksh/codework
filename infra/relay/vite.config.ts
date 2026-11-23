import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The suite starts Postgres in Docker and creates a Clerk test user.
		testTimeout: 60_000,
		hookTimeout: 120_000,
	},
});
