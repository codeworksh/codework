import { spawn } from "node:child_process";

const rendererHost = process.env.DESKTOP_RENDERER_HOST?.trim() || "127.0.0.1";
const rendererPort = process.env.DESKTOP_RENDERER_PORT?.trim() || "5733";
const rendererUrl = `http://${rendererHost}:${rendererPort}`;
const children = [];
let shuttingDown = false;

function start(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });

  children.push(child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const otherChild of children) {
      if (otherChild !== child && !otherChild.killed) {
        otherChild.kill("SIGTERM");
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

start("pnpm", ["run", "dev:bundle"], {
  ...process.env,
  VITE_DEV_SERVER_URL: rendererUrl,
});
start(
  "pnpm",
  [
    "--filter",
    "@codeworksh/webui",
    "dev",
    "--host",
    rendererHost,
    "--port",
    rendererPort,
  ],
  {
    ...process.env,
    VITE_DEV_SERVER_URL: rendererUrl,
  },
);
start("pnpm", ["run", "dev:electron"], {
  ...process.env,
  VITE_DEV_SERVER_URL: rendererUrl,
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
