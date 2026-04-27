import fs from "node:fs/promises";
import { OpenAPI } from "../src/server/openapi.ts";
import { Server } from "../src/server/server.ts";

const output = new URL("../openapi.json", import.meta.url);

Server.App();

await fs.writeFile(output, JSON.stringify(OpenAPI.document(), null, "\t") + "\n");
console.log(`OpenAPI spec written to ${output.pathname}`);
