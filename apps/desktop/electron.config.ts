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
	// The app is in English, so Chromium's other locales are left out of every installer.
	electronLanguages: ["en-US"],
	copyright: "Copyright © CodeWork",
	directories: { output: "dist", buildResources: "resources" },
	// appId too: on Windows the app takes it as its AppUserModelID, the one the installer gives its shortcuts.
	// channel: the app keeps its data in the CodeWork home under desktop/<channel>.
	extraMetadata: { name: packageName, productName, appId, channel, homepage: "https://www.codework.sh" },
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
		// A prebuilt icns: electron-builder's own PNG conversion garbles the small sizes, which the
		// DMG title bar shows.
		icon: "resources/icon.icns",
		// Ad-hoc: Apple silicon runs nothing unsigned. A downloaded build still needs its quarantine
		// flag removed until builds are signed and notarized.
		identity: "-",
		hardenedRuntime: false,
		// macOS 26 offers Messages and Mail codes in every text field unless the app opts out.
		extendInfo: { NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true },
	},
	dmg: { icon: "resources/icon.icns" },
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
	deb: {
		packageName,
		// electron-builder's list misses ALSA and GBM, which Electron loads; Debian 13 and Ubuntu 24.04
		// renamed some to 64-bit-time names, so the old names stay as fallbacks.
		depends: [
			"libasound2t64 | libasound2",
			"libatspi2.0-0t64 | libatspi2.0-0",
			"libgbm1",
			"libgtk-3-0t64 | libgtk-3-0",
			"libnotify4",
			"libnss3",
			"libsecret-1-0",
			"libuuid1",
			"libxss1",
			"libxtst6",
			"xdg-utils",
		],
	},
	pacman: { packageName },
	win: {
		// One installer per run, for the arch scripts/package.mjs builds for.
		target: "nsis",
		icon: "resources/icon.ico",
	},
	// The static AppImage runtime, so it runs without libfuse2.
	toolsets: { appimage: "1.0.3" },
	publish: null,
} satisfies Configuration;
