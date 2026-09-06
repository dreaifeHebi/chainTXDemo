import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
// Explicit public assets: never upload the workspace, output recordings or keys.
const files = ["index.html", "src/app.js", "src/infra-lab.js", "src/styles.css"];
const publicFiles = ["_headers", "404.html"];
const expected = new Set([...files, ...publicFiles]);
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (entry.isDirectory()) continue;
  const path = relative(dist, resolve(entry.parentPath, entry.name));
  if (!entry.isFile() || !expected.has(path)) {
    throw new Error(`Unexpected build output: ${path}. Use a fresh dist directory before deploying.`);
  }
}
for (const file of files) {
  await mkdir(dirname(resolve(dist, file)), { recursive: true });
  await copyFile(resolve(root, file), resolve(dist, file));
}
for (const file of publicFiles) await copyFile(resolve(root, "public", file), resolve(dist, file));
console.log(`Built ${expected.size} public files into dist; local recordings excluded.`);
