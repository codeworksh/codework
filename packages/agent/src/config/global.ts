import fs from "node:fs/promises";
import os from "os";
import path from "path";

// @sanchitrk: make it configurable, with envs perhaps
export const configDir = ".codework";
export const app = "codework";

const cacheDir = path.join(os.homedir(), configDir, "cache");
const agentDir = path.join(os.homedir(), configDir, "agent");
const dataDir = path.join(os.homedir(), configDir, "data");

export namespace Global {
  export const Path = {
    home: os.homedir(),
    cache: cacheDir,
    agent: agentDir,
    data: dataDir,
    log: path.join(dataDir, "log"),
  } as const;
}

await Promise.all([
  fs.mkdir(Global.Path.cache, { recursive: true }),
  fs.mkdir(Global.Path.agent, { recursive: true }),
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
]);
