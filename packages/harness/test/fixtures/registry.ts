import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A real npm registry on loopback, serving real tarballs.
 *
 * The point is to exercise pacote and arborist rather than a stub of them, while staying
 * hermetic: the fixture is what proves an install used the `.npmrc` the *host directory*
 * declares, because a chain read anywhere else reaches the public registry and 404s on a package
 * that does not exist there.
 *
 * It also counts what was asked for, which is the only way to assert a negative -- that no audit
 * was ever requested.
 */
export interface Registry {
	readonly url: string;
	/** Audit requests received. Arborist blocks on a report it never reads unless `audit: false`. */
	audits(): number;
	/** Every path requested, for asserting what a call did and did not reach for. */
	paths(): ReadonlyArray<string>;
	/** Move the `latest` dist-tag, so a mutable range has somewhere new to resolve to. */
	publish(tag: string): void;
}

export const NAME = "@fixture/plugin";

/** A package the loader will accept, optionally with a lifecycle script that must never run. */
const pack = async (directory: string, version: string, scripts: Record<string, string>) => {
	const root = join(directory, version, "package");
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: NAME, version, type: "module", exports: "./index.js", scripts }),
	);
	await writeFile(join(root, "index.js"), `export default { id: "fixture.plugin", version: "${version}" };\n`);
	await run("tar", ["-czf", "package.tgz", "package"], { cwd: join(directory, version) });
	return readFile(join(directory, version, "package.tgz"));
};

export const withRegistry = async (
	directory: string,
	body: (registry: Registry) => Promise<void>,
	options: { readonly scripts?: Record<string, string> } = {},
) => {
	const versions = ["1.0.0", "1.1.0"];
	const scripted = Object.keys(options.scripts ?? {}).length > 0;
	const tarballs = new Map<string, Buffer>();
	for (const version of versions) tarballs.set(version, await pack(directory, version, options.scripts ?? {}));

	let latest = "1.0.0";
	let audits = 0;
	const seen: string[] = [];

	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const pathname = decodeURIComponent(url.pathname);
		seen.push(pathname);
		if (pathname.startsWith("/-/npm/v1/security/")) {
			audits += 1;
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
			return;
		}
		if (pathname === `/${NAME}`) {
			const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					name: NAME,
					"dist-tags": { latest },
					versions: Object.fromEntries(
						versions.map((version) => [
							version,
							{
								name: NAME,
								version,
								// A real registry advertises this, and arborist uses it to decide
								// whether to even read the tarball's `scripts`. Without it a
								// package with a `postinstall` is treated as having none, and a
								// test that lifecycle scripts are blocked proves nothing.
								...(scripted ? { hasInstallScript: true } : {}),
								dist: { tarball: `${origin}/${version}.tgz` },
							},
						]),
					),
				}),
			);
			return;
		}
		const tarball = tarballs.get(pathname.replace(/^\/|\.tgz$/g, ""));
		if (tarball === undefined) {
			response.writeHead(404).end("missing");
			return;
		}
		response.writeHead(200, { "content-type": "application/octet-stream" }).end(tarball);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		await body({
			url,
			audits: () => audits,
			paths: () => seen,
			publish: (tag) => {
				latest = tag;
			},
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
};

/**
 * An `.npmrc` naming the fixture registry, written where a person's project keeps one.
 *
 * `fetch-retries=0` so a test that is *meant* to fail fails now. The registry is plain http, which
 * npm refuses to send auth to without being told the host is safe to talk to.
 */
export const npmrc = async (directory: string, registry: Registry, extra = "") => {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, ".npmrc"),
		`registry=${registry.url}\n@fixture:registry=${registry.url}\nfetch-retries=0\n${extra}`,
	);
};
