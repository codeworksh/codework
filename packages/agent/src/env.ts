import { loadEnvFile } from "node:process";

function loadEnvironment() {
	try {
		loadEnvFile();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

loadEnvironment();
