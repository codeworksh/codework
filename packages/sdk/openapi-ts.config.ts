import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
	input: "../agent/openapi.json",
	output: "src/generated",
	plugins: [
		"@hey-api/client-fetch",
		{
			name: "@hey-api/sdk",
			operations: {
				strategy: "single",
				containerName: "CodeWorkSdk",
				methods: "instance",
			},
		},
	],
});
