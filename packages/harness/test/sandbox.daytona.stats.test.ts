import type { FileInfo } from "@daytona/sdk";
import { describe, expect, it } from "vite-plus/test";
import { statsFrom } from "../src/sandbox/providers/daytona.ts";

// statsFrom maps the toolbox FileInfo to a FileStat. The contract: isFile and
// isDirectory are always present; size, mtime, and isSymbolicLink are omitted
// (never fabricated) when the toolbox does not report them.
const info = (partial: Partial<FileInfo>): FileInfo =>
	({
		name: "x",
		isDir: false,
		size: 0,
		mode: "-rw-r--r--",
		permissions: "644",
		modTime: "",
		modifiedAt: "2026-01-02T03:04:05Z",
		owner: "daytona",
		group: "daytona",
		...partial,
	}) as FileInfo;

describe("Daytona statsFrom", () => {
	it("maps a regular file", () => {
		const stat = statsFrom(info({ isDir: false, size: 42, modifiedAt: "2026-01-02T03:04:05Z" }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(42);
		expect(stat.mtime).toEqual(new Date("2026-01-02T03:04:05Z"));
	});

	it("maps a directory", () => {
		const stat = statsFrom(info({ isDir: true, mode: "drwxr-xr-x" }));
		expect(stat.isDirectory).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("detects symlinks from the mode string", () => {
		const stat = statsFrom(info({ isDir: false, mode: "lrwxrwxrwx" }));
		expect(stat.isSymbolicLink).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("omits size and mtime the toolbox did not report, never fabricating them", () => {
		const stat = statsFrom(info({ size: undefined as unknown as number, modifiedAt: "", modTime: "" }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect("size" in stat).toBe(false);
		expect("mtime" in stat).toBe(false);
	});

	it("omits isSymbolicLink when mode is unavailable", () => {
		const stat = statsFrom(info({ mode: undefined as unknown as string }));
		expect("isSymbolicLink" in stat).toBe(false);
		expect(stat.isFile).toBe(true);
	});
});
