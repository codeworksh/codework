import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

/** A packaged app's package.json, as electron.config.ts writes it. */
export const manifest = () =>
	JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as {
		readonly appId: string;
		readonly channel: "latest" | "dev" | "canary";
	};
