/**
 * Terminal affordances an interactive OAuth login needs: open the
 * authorization URL, and read a pasted code back.
 *
 * Shared so the aikit CLI and anything built on these flows behave the same —
 * they previously kept private copies, and the copies drifted.
 */

/**
 * Open a URL in the platform browser.
 *
 * `spawn` reports a missing launcher asynchronously, as an `error` event rather
 * than a throw or a rejected promise, so an unhandled one takes the process
 * down — on a box without `xdg-open`, printing a URL would become a crash.
 * `onError` receives that instead.
 */
export async function openBrowser(url: string, onError?: (error: Error) => void): Promise<void> {
	const { spawn } = await import("node:child_process");
	const command =
		process.platform === "darwin"
			? { file: "open", args: [url] }
			: process.platform === "win32"
				? { file: "cmd", args: ["/c", "start", "", url] }
				: { file: "xdg-open", args: [url] };

	const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
	child.on("error", (error) => onError?.(error));
	child.unref();
}

/** Read one line from stdin, prompting on stdout. */
export async function promptLine(message: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await readline.question(`${message} `);
	} finally {
		readline.close();
	}
}
