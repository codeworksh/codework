/*
 * @file The one path rule shared by every boundary the harness has: absolute, or it is a mistake.
 */

import { hostPath as path } from "../host.ts";

/**
 * A directory that crosses into the harness is absolute, and a relative one is a **defect** rather
 * than an error.
 *
 * A relative path is a disguised `process.cwd()` call: and every consumer
 * resolves it silently. `path.resolve("x")` anchors to the process directory, npm answers a
 * relative `cwd` with a `localPrefix` of whatever repository the process is inside (measured, not
 * assumed), and `Session.link` would write the *server's* directory into a field whose whole
 * purpose is to be a host path the client declared.
 *
 * For a long-running server the process directory is nobody's project, so the result is a
 * plausible answer to a question no one asked.
 * An absolute path is the one spelling none of them can quietly reinterpret.
 *
 * A defect rather than a typed error because nothing a user types reaches here. Every reference
 * goes through `parse`, and every directory comes from `Global.resolve`, a resolved `cwd` or a
 * session's `hostDir`, all of them already absolute. A relative one means a new call site got it
 * wrong, and a stack trace names that call site; a typed error would ask every caller to handle a
 * case none of them can cause.
 */
export const rooted = (directory: string, role: string): string => {
	if (path.isAbsolute(directory)) return directory;
	throw new Error(`${role} must be an absolute path, got ${JSON.stringify(directory)}`);
};
