import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { prepareRelease } from "./release-version.mjs";

for (const key of ["GITHUB_SHA", "GITHUB_OUTPUT", "GITHUB_API_URL", "GH_REPO", "GH_TOKEN"]) {
  assert(process.env[key], `${key}が必要です（GitHub ActionsのReleaseワークフローから実行してください）`);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), process.env.GITHUB_SHA, "ビルド対象のコミットが一致しません");
const tagNames = git("tag", "--list", "v*").split("\n").filter(Boolean);
const tags = tagNames.map((name) => ({ name, commit: git("rev-parse", `${name}^{commit}`) }));
const result = await prepareRelease({
  root: process.cwd(),
  tags,
  commit: process.env.GITHUB_SHA,
  async getRelease(tag) {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GH_REPO}/releases/tags/${tag}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Releaseの確認に失敗しました: HTTP ${response.status}`);
    return response.json();
  },
});
await appendFile(process.env.GITHUB_OUTPUT,
  `tag=${result.tag}\nversion=${result.version}\nexists=${result.exists}\n`);
console.log(result.exists ? `${result.tag}はこのコミットで公開済みのためスキップします` : `${result.tag}でパッケージ化します`);
