import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { prepareRelease } from "./release-version.mjs";
import { createGitHubClient } from "./github-release-api.mjs";

for (const key of ["GITHUB_SHA", "GITHUB_OUTPUT", "GITHUB_API_URL", "GH_REPO", "GH_TOKEN"]) {
  assert(process.env[key], `${key}が必要です（GitHub ActionsのReleaseワークフローから実行してください）`);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), process.env.GITHUB_SHA, "ビルド対象のコミットが一致しません");
const tagNames = git("tag", "--list", "v*").split("\n").filter(Boolean);
const tags = tagNames.map((name) => ({ name, commit: git("rev-parse", `${name}^{commit}`) }));
const { getRelease } = createGitHubClient({
  apiUrl: process.env.GITHUB_API_URL, repo: process.env.GH_REPO, token: process.env.GH_TOKEN,
});
const result = await prepareRelease({
  root: process.cwd(),
  tags,
  commit: process.env.GITHUB_SHA,
  getRelease,
});
await appendFile(process.env.GITHUB_OUTPUT,
  `tag=${result.tag}\nversion=${result.version}\nexists=${result.exists}\n`);
console.log(result.exists ? `${result.tag}の既存Releaseをビルド後に検証・再開します` : `${result.tag}でパッケージ化します`);
