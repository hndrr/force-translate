import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const scriptFiles = ["background.js", "content.js", "popup.js"];

export async function build() {
  const output = await mkdtemp(path.join(tmpdir(), "force-translate-build-"));
  try {
    execFileSync(process.execPath, [
      path.join(projectRoot, "node_modules/typescript/bin/tsc"),
      "-p", path.join(projectRoot, "tsconfig.json"),
      "--outDir", output,
    ], { cwd: projectRoot, stdio: "inherit" });
    await mkdir(path.join(projectRoot, ".build"), { recursive: true });
    for (const file of scriptFiles) {
      await copyFile(path.join(output, file), path.join(projectRoot, ".build", file));
      await copyFile(path.join(output, file), path.join(projectRoot, file));
    }
    console.log("ビルド完了: background.js / content.js / popup.js");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}
