import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

function readStdin() {
	return new Promise((resolveStdin, rejectStdin) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolveStdin(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", rejectStdin);
	});
}

function run(command, args, cwd) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", rejectRun);
		child.on("close", (code) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			rejectRun(new Error(stderr || `${command} exited with code ${code ?? 1}`));
		});
	});
}

const bufferPath = process.argv[2];
if (!bufferPath) {
	console.error("Missing buffer path");
	process.exit(1);
}

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const relativePath = relative(repoRoot, bufferPath);
const tempRoot = resolve(tmpdir(), "codework-zed-vp-fmt");
const tempPath = resolve(tempRoot, relativePath);

try {
	const input = await readStdin();
	await mkdir(dirname(tempPath), { recursive: true });
	await writeFile(tempPath, input, "utf8");
	await run("vp", ["fmt", "--write", tempPath], repoRoot);
	const output = await readFile(tempPath, "utf8");
	process.stdout.write(output);
} finally {
	await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
