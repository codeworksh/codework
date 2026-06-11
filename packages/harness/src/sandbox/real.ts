import {
	RealFSProvider,
	type MkdirOptions,
	type ReaddirOptions,
	type StatOptions,
	type VirtualDirent,
	type VirtualStats,
} from "@platformatic/vfs";
import fs from "node:fs";
import path from "node:path";

function escapeError(input: string): NodeJS.ErrnoException {
	const error = new Error(`EACCES: path escapes sandbox root, '${input}'`) as NodeJS.ErrnoException;
	error.code = "EACCES";
	error.path = input;
	return error;
}

/**
 * RealFSProvider checks lexical `..` traversal, but follows host symlinks
 * without checking where they resolve. This wrapper keeps the same VFS API
 * while confining every operation to the canonical root.
 */
export class ConfinedRealFSProvider extends RealFSProvider {
	private readonly canonicalRoot: string;

	constructor(rootPath: string) {
		super(rootPath);
		this.canonicalRoot = fs.realpathSync(this.rootPath);
	}

	private canonicalCandidate(candidate: string) {
		const relative = path.relative(this.rootPath, candidate);
		if (
			relative === "" ||
			(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		) {
			return path.resolve(this.canonicalRoot, relative);
		}
		return candidate;
	}

	private isInsideRoot(candidate: string) {
		const relative = path.relative(this.canonicalRoot, this.canonicalCandidate(candidate));
		return (
			relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		);
	}

	private hostPath(vfsPath: string) {
		const hostPath =
			vfsPath === this.rootPath || vfsPath.startsWith(`${this.rootPath}${path.sep}`)
				? path.resolve(vfsPath)
				: path.resolve(this.rootPath, vfsPath.replace(/^[/\\]+/, ""));

		const relative = path.relative(this.rootPath, hostPath);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw escapeError(vfsPath);
		}
		return hostPath;
	}

	private assertResolved(hostPath: string, input: string) {
		const resolved = fs.realpathSync(hostPath);
		if (!this.isInsideRoot(resolved)) throw escapeError(input);
	}

	private assertNearestExisting(hostPath: string, input: string) {
		let current = hostPath;
		while (true) {
			try {
				this.assertResolved(current, input);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
				const parent = path.dirname(current);
				if (parent === current) throw error;
				current = parent;
			}
		}
	}

	private assertFollow(pathname: string) {
		const hostPath = this.hostPath(pathname);
		try {
			fs.lstatSync(hostPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw error;
			this.assertNearestExisting(path.dirname(hostPath), pathname);
			return;
		}
		this.assertResolved(hostPath, pathname);
	}

	private assertParent(pathname: string) {
		const hostPath = this.hostPath(pathname);
		this.assertNearestExisting(hostPath === this.rootPath ? hostPath : path.dirname(hostPath), pathname);
	}

	private safeSymlinkTarget(target: string, linkPath: string) {
		const linkHostPath = this.hostPath(linkPath);
		if (path.isAbsolute(target)) return this.hostPath(target);

		const targetHostPath = path.resolve(path.dirname(linkHostPath), target);
		if (!this.isInsideRoot(targetHostPath)) throw escapeError(target);
		return target;
	}

	private virtualSymlinkTarget(target: string, linkPath: string) {
		if (!path.isAbsolute(target)) {
			const targetHostPath = path.resolve(path.dirname(this.hostPath(linkPath)), target);
			if (!this.isInsideRoot(targetHostPath)) throw escapeError(target);
			return target;
		}
		if (!this.isInsideRoot(target)) throw escapeError(target);
		const relative = path.relative(this.canonicalRoot, this.canonicalCandidate(target)).split(path.sep).join("/");
		return relative ? `/${relative}` : "/";
	}

	override openSync(pathname: string, flags?: string, mode?: number): unknown {
		this.assertFollow(pathname);
		return super.openSync(pathname, flags, mode);
	}

	override open(pathname: string, flags?: string, mode?: number): Promise<unknown> {
		this.assertFollow(pathname);
		return super.open(pathname, flags, mode);
	}

	override statSync(pathname: string, options?: StatOptions): VirtualStats {
		this.assertFollow(pathname);
		return super.statSync(pathname, options);
	}

	override stat(pathname: string, options?: StatOptions): Promise<VirtualStats> {
		this.assertFollow(pathname);
		return super.stat(pathname, options);
	}

	override lstatSync(pathname: string, options?: StatOptions): VirtualStats {
		this.assertParent(pathname);
		return super.lstatSync(pathname, options);
	}

	override lstat(pathname: string, options?: StatOptions): Promise<VirtualStats> {
		this.assertParent(pathname);
		return super.lstat(pathname, options);
	}

	override readdirSync(pathname: string, options?: ReaddirOptions): string[] | VirtualDirent[] {
		this.assertFollow(pathname);
		return super.readdirSync(pathname, options);
	}

	override readdir(pathname: string, options?: ReaddirOptions): Promise<string[] | VirtualDirent[]> {
		this.assertFollow(pathname);
		return super.readdir(pathname, options);
	}

	override mkdirSync(pathname: string, options?: MkdirOptions): string | undefined {
		this.assertParent(pathname);
		return super.mkdirSync(pathname, options);
	}

	override mkdir(pathname: string, options?: MkdirOptions): Promise<string | undefined> {
		this.assertParent(pathname);
		return super.mkdir(pathname, options);
	}

	override rmdirSync(pathname: string): void {
		this.assertParent(pathname);
		return super.rmdirSync(pathname);
	}

	override rmdir(pathname: string): Promise<void> {
		this.assertParent(pathname);
		return super.rmdir(pathname);
	}

	override unlinkSync(pathname: string): void {
		this.assertParent(pathname);
		return super.unlinkSync(pathname);
	}

	override unlink(pathname: string): Promise<void> {
		this.assertParent(pathname);
		return super.unlink(pathname);
	}

	override renameSync(oldPath: string, newPath: string): void {
		this.assertParent(oldPath);
		this.assertParent(newPath);
		return super.renameSync(oldPath, newPath);
	}

	override rename(oldPath: string, newPath: string): Promise<void> {
		this.assertParent(oldPath);
		this.assertParent(newPath);
		return super.rename(oldPath, newPath);
	}

	override copyFileSync(src: string, dest: string, mode?: number): void {
		this.assertFollow(src);
		this.assertFollow(dest);
		return super.copyFileSync(src, dest, mode);
	}

	override copyFile(src: string, dest: string, mode?: number): Promise<void> {
		this.assertFollow(src);
		this.assertFollow(dest);
		return super.copyFile(src, dest, mode);
	}

	override accessSync(pathname: string, mode?: number): void {
		this.assertFollow(pathname);
		return super.accessSync(pathname, mode);
	}

	override access(pathname: string, mode?: number): Promise<void> {
		this.assertFollow(pathname);
		return super.access(pathname, mode);
	}

	override realpathSync(pathname: string, options?: { encoding?: BufferEncoding }): string {
		this.assertFollow(pathname);
		const resolved = fs.realpathSync(this.hostPath(pathname), options);
		const relative = path.relative(this.canonicalRoot, resolved).split(path.sep).join("/");
		return relative ? `/${relative}` : "/";
	}

	override async realpath(pathname: string, options?: { encoding?: BufferEncoding }): Promise<string> {
		this.assertFollow(pathname);
		const resolved = await fs.promises.realpath(this.hostPath(pathname), options);
		const relative = path.relative(this.canonicalRoot, resolved).split(path.sep).join("/");
		return relative ? `/${relative}` : "/";
	}

	override readlinkSync(pathname: string, options?: { encoding?: BufferEncoding }): string {
		this.assertParent(pathname);
		return this.virtualSymlinkTarget(super.readlinkSync(pathname, options), pathname);
	}

	override async readlink(pathname: string, options?: { encoding?: BufferEncoding }): Promise<string> {
		this.assertParent(pathname);
		return this.virtualSymlinkTarget(await super.readlink(pathname, options), pathname);
	}

	override symlinkSync(target: string, pathname: string, type?: string): void {
		this.assertParent(pathname);
		return super.symlinkSync(this.safeSymlinkTarget(target, pathname), pathname, type);
	}

	override symlink(target: string, pathname: string, type?: string): Promise<void> {
		this.assertParent(pathname);
		return super.symlink(this.safeSymlinkTarget(target, pathname), pathname, type);
	}
}
