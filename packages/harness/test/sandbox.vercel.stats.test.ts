import type { Stats } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { statsFrom } from "../src/sandboxes/vercel/provider.ts";

// statsFrom maps the SDK's `node:fs` Stats to a FileStat. The contract: isFile,
// isDirectory, and isSymbolicLink are always present; size and mtime are omitted
// (never fabricated) when the stat does not report a finite/valid value.
const stats = (partial: {
	isFile?: boolean;
	isDirectory?: boolean;
	isSymbolicLink?: boolean;
	size?: number;
	mtime?: Date;
}): Stats =>
	({
		isFile: () => partial.isFile ?? false,
		isDirectory: () => partial.isDirectory ?? false,
		isSymbolicLink: () => partial.isSymbolicLink ?? false,
		size: partial.size ?? 0,
		mtime: partial.mtime ?? new Date(0),
	}) as Stats;

describe("Vercel statsFrom", () => {
	it("maps a regular file", () => {
		const stat = statsFrom(stats({ isFile: true, size: 42, mtime: new Date("2026-01-02T03:04:05Z") }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(42);
		expect(stat.mtime).toEqual(new Date("2026-01-02T03:04:05Z"));
	});

	it("maps a directory", () => {
		const stat = statsFrom(stats({ isDirectory: true }));
		expect(stat.isDirectory).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("detects symlinks", () => {
		const stat = statsFrom(stats({ isSymbolicLink: true }));
		expect(stat.isSymbolicLink).toBe(true);
		expect(stat.isFile).toBe(false);
	});

	it("omits size and mtime the stat did not report, never fabricating them", () => {
		const stat = statsFrom(stats({ isFile: true, size: Number.NaN, mtime: new Date(Number.NaN) }));
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect("size" in stat).toBe(false);
		expect("mtime" in stat).toBe(false);
	});
});
