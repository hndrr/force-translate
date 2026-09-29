import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { collectFiles, createArchive } from "./package-lib.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "force-translate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    manifest_version: 3, name: "Test", version: "1.0.0", description: "Test extension",
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  for (const name of ["background.js", "content.js", "popup.js"]) {
    await writeFile(path.join(root, name), "console.log('test');\n");
  }
  await writeFile(path.join(root, "popup.html"), '<link href="popup.css"><script src="popup.js"></script>');
  await writeFile(path.join(root, "popup.css"), "body { color: black; }");
  return { root, manifest };
}

test("ZIP直下に実行ファイルだけを収録し、内容を保って再現可能なZIPを作る", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "private.pem"), "must not be included");
  await writeFile(path.join(root, "old.js"), "stale build");
  const { files } = await collectFiles(root);
  const zip = createArchive(files);
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked).sort(), ["background.js", "content.js", "manifest.json", "popup.css", "popup.html", "popup.js"]);
  assert.deepEqual(Buffer.from(unpacked["manifest.json"]), await readFile(path.join(root, "manifest.json")));
  assert.deepEqual(createArchive(files), zip);
});

test("不足しているポップアップの参照先を検出する", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "popup.html"), '<script src="missing.js"></script>');
  await assert.rejects(collectFiles(root), /参照先が配布対象にありません/);
});

test("通常のスクリプトで読み込めないESM構文を検出する", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "content.js"), "export {};");
  await assert.rejects(collectFiles(root), SyntaxError);
});

test("manifestの不正なバージョン番号を検出する", async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.version = "1.0.0-beta";
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(collectFiles(root), /バージョン番号が不正/);
});

test("配布対象外へのパスを検出する", async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.icons = { 128: "../private.png" };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(collectFiles(root), /安全な相対パスではありません/);
});

test("存在しない実行ファイルを検出する", async (t) => {
  const { root } = await fixture(t);
  await rm(path.join(root, "background.js"));
  await assert.rejects(collectFiles(root), { code: "ENOENT" });
});

test("拡張アイコンとツールバーアイコンを両方含め、寸法の誤りを検出する", async (t) => {
  const { root, manifest } = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  manifest.icons = { 1: "icon.png" };
  manifest.action.default_icon = { 1: "toolbar.png" };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "icon.png"), png);
  await writeFile(path.join(root, "toolbar.png"), png);
  const { files } = await collectFiles(root);
  assert.deepEqual(Buffer.from(files["icon.png"]), png);
  assert.deepEqual(Buffer.from(files["toolbar.png"]), png);
  manifest.icons = { 128: "icon.png" };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(collectFiles(root), /寸法が128x128ではありません/);
});

test("ZIPのバイト列がUTC・東京・ロサンゼルスで一致する", () => {
  const moduleURL = new URL("./package-lib.mjs", import.meta.url).href;
  const script = `import { createArchive } from ${JSON.stringify(moduleURL)};
    process.stdout.write(createArchive({"a.txt": new TextEncoder().encode("same payload")}));`;
  const archives = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((TZ) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ } }));
  for (const zip of archives.slice(1)) assert.deepEqual(zip, archives[0]);
});

for (const [label, fields] of [
  ["side_panel", { side_panel: { default_path: "pages/settings.html" } }],
  ["options_page", { options_page: "pages/settings.html" }],
  ["options_ui", { options_ui: { page: "pages/settings.html" } }],
  ["devtools_page", { devtools_page: "pages/settings.html" }],
  ["chrome_url_overrides", { chrome_url_overrides: { newtab: "pages/settings.html" } }],
  ["sandbox", { sandbox: { pages: ["pages/settings.html"] } }],
]) {
  test(`${label}のページを同梱し、ページや依存ファイルの欠落を検出する`, async (t) => {
    const { root, manifest } = await fixture(t);
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ ...manifest, ...fields }));
    await assert.rejects(collectFiles(root), { code: "ENOENT" });
    await mkdir(path.join(root, "pages"));
    const pagePath = path.join(root, "pages/settings.html");
    await writeFile(pagePath, '<script src="../popup.js"></script>');
    const { files } = await collectFiles(root);
    assert.deepEqual(Buffer.from(unzipSync(createArchive(files))["pages/settings.html"]), await readFile(pagePath));
    await writeFile(pagePath, '<script src="missing.js"></script>');
    await assert.rejects(collectFiles(root), /参照先が配布対象にありません/);
  });
}
