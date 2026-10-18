import type { Configuration } from "electron-builder";

// One identity per channel, so channels install side by side with their own data. The version
// is the run's, passed by scripts/package.mjs.
const CHANNELS = {
	latest: { productName: "CodeWork", appId: "sh.codework.desktop", packageName: "codework-desktop" },
	dev: { productName: "CodeWork Dev", appId: "sh.codework.desktop.dev", packageName: "codework-desktop-dev" },
	canary: {
		productName: "CodeWork Canary",
		appId: "sh.codework.desktop.canary",
		packageName: "codework-desktop-canary",
	},
} as const;

const channel = process.env.CODEWORK_CHANNEL;
if (channel !== "latest" && channel !== "dev" && channel !== "canary") {
	throw new Error(`CODEWORK_CHANNEL must be latest, dev or canary, not ${channel}`);
}
const { productName, appId, packageName } = CHANNELS[channel];

export default {
	appId,
	productName,
	// The same name on every channel; the release a file sits in says which channel it is.
	artifactName: "codework-desktop-${os}-${arch}.${ext}",
	// Nothing native to rebuild: the app server uses node:sqlite.
	npmRebuild: false,
	copyright: "Copyright © CodeWork",
	directories: { output: "dist", buildResources: "resources" },
	extraMetadata: { name: packageName, productName, homepage: "https://www.codework.sh" },
	// The app is its two bundles and its icon; Electron is the only dependency, and it is the runtime.
	files: ["out/*.cjs", "resources/icon.png", "package.json"],
	// The app server runs as its own process from Resources, so it sits outside the asar archive.
	extraResources: [
		{ from: "../server/dist/index.mjs", to: "server/index.mjs" },
		{ from: "../web/dist", to: "web" },
	],
	mac: {
		target: [
			{ target: "dmg", arch: "arm64" },
			{ target: "zip", arch: "arm64" },
		],
		category: "public.app-category.developer-tools",
		icon: "resources/icon.png",
		// Ad-hoc: Apple silicon runs nothing unsigned. A downloaded build still needs its quarantine
		// flag removed until builds are signed and notarized.
		identity: "-",
		hardenedRuntime: false,
	},
	linux: {
		// Each format names x64 and arm64 its own way (x86_64, amd64, aarch64); one name for all,
		// from the arch scripts/package.mjs builds for.
		artifactName: "codework-desktop-linux-${env.CODEWORK_ARCH}.${ext}",
		target: ["AppImage", "deb", "pacman"],
		category: "Development",
		icon: "resources/icon.png",
		maintainer: "CodeWork",
		executableName: packageName,
	},
	deb: { packageName },
	pacman: { packageName },
	// The static AppImage runtime, so it runs without libfuse2.
	toolsets: { appimage: "1.0.3" },
	publish: null,
} satisfies Configuration;
