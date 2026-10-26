/**
 * Terminal affordances an interactive OAuth login needs: open the
 * authorization URL, read a pasted code back, and the page the browser
 * shows after the callback.
 *
 * Shared so the aikit CLI and anything built on these flows behave the same —
 * they previously kept private copies, and the copies drifted.
 */

import dedent from "dedent";

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

function oauthPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const escapeHtml = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	const details = options.details ? escapeHtml(options.details) : undefined;

	return dedent`
	<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeHtml(options.title)}</title>
		<style>
			html { color-scheme: dark; }
			body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
			background: #09090b;
			color: #fafafa;
			font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			text-align: center;
			}
			main { width: 100%; max-width: 560px; }
			h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
			p { margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }
			.details { margin-top: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #a1a1aa; white-space: pre-wrap; word-break: break-word; }
		</style>
	</head>
	<body>
		<main>
			<h1>${escapeHtml(options.heading)}</h1>
			<p>${escapeHtml(options.message)}</p>
			${details ? `<div class="details">${details}</div>` : ""}
		</main>
	</body>
	</html>
	`;
}

/** The browser page an OAuth callback answers with after a sign-in. */
export function oauthSuccessHtml(message: string): string {
	return oauthPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

/** The browser page an OAuth callback answers with when a sign-in failed. */
export function oauthErrorHtml(message: string, details?: string): string {
	return oauthPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		...(details !== undefined && { details }),
	});
}
