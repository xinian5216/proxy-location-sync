/**
 * 共享源码 → Chromium / Firefox 两套包。
 * Chrome 116–120 不能在 MV3 里带 background.scripts（会拒载），所以不能合成一份 manifest。
 * 2026-09-05 MDN：Firefox 仍不支持 background.service_worker（bug 1573659）。
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

export function mergeManifest(base, overlay) {
  return { ...base, ...overlay };
}

export function loadManifest(target) {
  const base = JSON.parse(readFileSync(join(root, "manifests/base.json"), "utf8"));
  const overlay = JSON.parse(readFileSync(join(root, "manifests", `${target}.json`), "utf8"));
  const merged = mergeManifest(base, overlay);
  merged.version = version;
  return merged;
}

function copyTree(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of [
    "background",
    "content",
    "diagnostics",
    "icons",
    "lib",
    "offscreen",
    "options",
    "popup",
    "tests",
    "manifests",
    "scripts",
    "LICENSE",
    "README.md",
    "package.json",
  ]) {
    cpSync(join(root, name), join(dest, name), { recursive: true });
  }
}

function zipDir(src, zipPathNoExt) {
  execFileSync("python3", ["-c", "import shutil, sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])", zipPathNoExt, src], {
    stdio: "inherit",
  });
}

export function buildTarget(target) {
  const dest = join(root, "dist", target);
  copyTree(dest);
  const manifest = loadManifest(target);
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (target === "chromium") {
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { dest, manifest };
}

export function packageAll() {
  const chromium = buildTarget("chromium");
  const firefox = buildTarget("firefox");
  const outDir = join(root, "dist");
  const cZip = join(outDir, `proxy-location-sync-chromium-${version}`);
  const fZip = join(outDir, `proxy-location-sync-firefox-${version}`);
  zipDir(chromium.dest, cZip);
  zipDir(firefox.dest, fZip);
  return {
    version,
    chromium: `${cZip}.zip`,
    firefox: `${fZip}.zip`,
  };
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const arg = process.argv[2] || "all";
  if (arg === "chromium") {
    const r = buildTarget("chromium");
    console.log("built chromium", r.dest, r.manifest.version);
  } else if (arg === "firefox") {
    const r = buildTarget("firefox");
    console.log("built firefox", r.dest, r.manifest.version);
  } else if (arg === "package" || arg === "all") {
    const r = packageAll();
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error("usage: build-extension.mjs [chromium|firefox|package]");
    process.exit(1);
  }
}
