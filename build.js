#!/usr/bin/env node
// Levora build: copies src/ into dist/<target>/ and drops in the right manifest.
// No dependencies. Run with `node build.js` or `node build.js --zip`.

import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = ["chrome", "firefox"];

async function buildTarget(target) {
  const outDir = path.join(root, "dist", target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await cp(path.join(root, "src"), outDir, { recursive: true });

  const manifest = await readFile(
    path.join(root, "manifests", `${target}.json`),
    "utf8",
  );
  await writeFile(path.join(outDir, "manifest.json"), manifest);

  return outDir;
}

// Node has no built-in zip, so shell out to whatever the platform ships with.
async function zipDir(dir, zipPath) {
  await rm(zipPath, { force: true });
  if (process.platform === "win32") {
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
  } else {
    await execFileAsync("zip", ["-r", "-q", zipPath, "."], { cwd: dir });
  }
}

const shouldZip = process.argv.includes("--zip");

for (const target of TARGETS) {
  const outDir = await buildTarget(target);
  console.log(`built  dist/${target}`);
  if (shouldZip) {
    const zipPath = path.join(root, "dist", `levora-${target}.zip`);
    await zipDir(outDir, zipPath);
    console.log(`packed dist/levora-${target}.zip`);
  }
}
