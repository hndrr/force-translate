import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { collectFiles, createArchive } from "./package-lib.mjs";
import { planRelease, prepareRelease } from "./release-version.mjs";

const tag = (name, commit = "older") => ({ name, commit });

test("初回はmanifestのバージョンを使い、次のコミットではパッチ番号を増やす", () => {
  assert.equal(planRelease("0.5.0", [], "current").version, "0.5.0");
  assert.equal(planRelease("0.5.0", [tag("v0.5.0")], "current").version, "0.5.1");
  assert.equal(planRelease("0.5.0", [tag("v0.5.0"), tag("v0.5.1")], "current").version, "0.5.2");
});

test("タグを数値順で比較し、無関係なタグやプレリリース名を除外する", () => {
  const tags = [tag("v0.5.9"), tag("v0.5.10"), tag("v9.0.0-beta"), tag("backup"), tag("v01.0.0")];
  assert.equal(planRelease("0.5.0", tags, "current").version, "0.5.11");
});

test("同じコミットの再実行では元のバージョンを再利用する", () => {
  const tags = [tag("v0.5.1", "current"), tag("v0.5.2", "later")];
  assert.deepEqual(planRelease("0.5.0", tags, "current"), {
    version: "0.5.1", tag: "v0.5.1", reused: true,
  });
});

test("明示した大きいバージョンを採用し、古いmanifestでも公開番号を下げない", () => {
  assert.equal(planRelease("1.0.0", [tag("v0.5.10")], "current").version, "1.0.0");
  assert.equal(planRelease("0.1.0", [tag("v0.5.10")], "current").version, "0.5.11");
});

test("Chromeの桁数と各桁の上限を守って繰り上げる", () => {
  assert.equal(planRelease("1", [tag("v1")], "current").version, "1.0.1");
  assert.equal(planRelease("1.0.0", [tag("v1.2.65535")], "current").version, "1.3.0");
  assert.equal(planRelease("1.0.0", [tag("v1.2.3.65535")], "current").version, "1.2.4.0");
  assert.throws(() => planRelease("1.0.0", [tag("v65535.65535.65535.65535")], "current"), /上限/);
  assert.throws(() => planRelease("0.0.0", [], "current"), /不正/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "force-translate-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    manifest_version: 3, name: "Test", description: "Test", version: "0.5.0",
    background: { service_worker: "background.js" }, action: { default_popup: "popup.html" },
  };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

test("自動採番をZIP内のmanifestにも反映する", async (t) => {
  const root = await fixture(t);
  const result = await prepareRelease({ root, tags: [tag("v0.5.0")], commit: "current", getRelease: async () => null });
  for (const name of ["background.js", "content.js", "popup.js"]) await writeFile(path.join(root, name), "void 0;");
  await writeFile(path.join(root, "popup.html"), '<script src="popup.js"></script>');
  await writeFile(path.join(root, "popup.css"), "");
  const { files, manifest } = await collectFiles(root);
  const zipManifest = JSON.parse(Buffer.from(unzipSync(createArchive(files))["manifest.json"]).toString());
  assert.equal(result.tag, "v0.5.1");
  assert.equal(manifest.version, "0.5.1");
  assert.equal(zipManifest.version, "0.5.1");
});

test("公開済みの同じコミットはスキップし、タグだけなら同じ番号で再開する", async (t) => {
  const root = await fixture(t);
  const input = { root, tags: [tag("v0.5.1", "current")], commit: "current" };
  const done = await prepareRelease({ ...input, getRelease: async () => ({ draft: false }) });
  assert.equal(done.exists, true);
  const resumed = await prepareRelease({ ...input, getRelease: async () => null });
  assert.equal(resumed.exists, false);
  assert.equal(resumed.version, "0.5.1");
});

test("APIエラーや採番の競合があればmanifestを書き換えず停止する", async (t) => {
  const root = await fixture(t);
  const before = await readFile(path.join(root, "manifest.json"), "utf8");
  const input = { root, tags: [tag("v0.5.0")], commit: "current" };
  await assert.rejects(prepareRelease({ ...input, getRelease: async () => { throw new Error("HTTP 403"); } }), /403/);
  await assert.rejects(prepareRelease({ ...input, getRelease: async () => ({ draft: false }) }), /採番中/);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), before);
});
