import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishRelease } from "./release-publish.mjs";
import { createGitHubClient } from "./github-release-api.mjs";

for (const name of ["RELEASE_TAG", "RELEASE_COMMIT", "GH_TOKEN", "GH_REPO", "GITHUB_API_URL"]) {
  assert(process.env[name], `${name}が必要です`);
}
const tag = process.env.RELEASE_TAG;
const commit = process.env.RELEASE_COMMIT;
const manifest = JSON.parse(await readFile("dist/extension/manifest.json", "utf8"));
assert.equal(tag, `v${manifest.version}`, "ZIPとタグのバージョンが一致しません");
const zipName = `force-translate-${manifest.version}.zip`;
const files = {};
for (const name of [zipName, `${zipName}.sha256`, "release-checklist.md"]) {
  files[name] = await readFile(path.join("dist", name));
}
assert.equal(files[`${zipName}.sha256`].toString().trim(),
  `${createHash("sha256").update(files[zipName]).digest("hex")}  ${zipName}`, "ZIPのチェックサムが一致しません");
const { request, getRelease } = createGitHubClient({
  apiUrl: process.env.GITHUB_API_URL, repo: process.env.GH_REPO, token: process.env.GH_TOKEN,
});

const gh = (...args) => execFileSync("gh", args, { stdio: "inherit" });
const result = await publishRelease({ tag, commit, files, api: {
  getRelease,
  async getTagCommit(name) {
    const ref = await request(`git/ref/tags/${encodeURIComponent(name)}`, { optional: true });
    if (!ref) return null;
    let object = ref.object;
    // Annotated tags may themselves point at annotated tags.
    for (let depth = 0; object.type === "tag" && depth < 10; depth++) {
      object = (await request(`git/tags/${object.sha}`)).object;
    }
    assert.equal(object.type, "commit", "タグの対象コミットを解決できません");
    return object.sha;
  },
  getAssetBytes: (asset) => request(`releases/assets/${asset.id}`, { binary: true }),
  createDraft: (name, sha) => gh("release", "create", name, "--draft", "--target", sha,
    "--title", `Force Translate ${name}`, "--generate-notes"),
  uploadAsset: (name, file) => gh("release", "upload", name, path.join("dist", file), "--clobber"),
  publishDraft: (name) => gh("release", "edit", name, "--draft=false"),
} });
console.log(result === "verified" ? `${tag}: 公開済みのコミットと全添付ファイルが一致しました` : `${tag}: 検証済みの添付ファイルを公開しました`);
