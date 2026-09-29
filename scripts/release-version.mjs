import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Parse Chrome's numeric version format, returning null for invalid input. */
function parseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every((part) => part <= 65535) && parts.some((part) => part > 0) ? parts : null;
}

/** Compare numeric components, treating missing components as zero. */
function compare(left, right) {
  for (let i = 0; i < 4; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** Increment the final component with carry, respecting Chrome's size limits. */
function increment(parts) {
  const next = [...parts];
  while (next.length < 3) next.push(0);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 65535) {
      next[i]++;
      return next.join(".");
    }
    next[i] = 0;
  }
  throw new Error("Chrome拡張のバージョン番号の上限に達しました");
}

/** Reserve a new version or reuse a version already assigned to this commit. */
export function planRelease(baseVersion, tags, commit) {
  const base = parseVersion(baseVersion);
  assert(base, "manifest.jsonのバージョン番号が不正です");
  assert(commit, "公開するコミットが必要です");
  const versions = tags.filter(({ name }) => name.startsWith("v"))
    .map((tag) => ({ ...tag, parts: parseVersion(tag.name.slice(1)) }))
    .filter(({ parts }) => parts)
    .sort((a, b) => compare(b.parts, a.parts));
  const previous = versions.find((tag) => tag.commit === commit);
  if (previous) return { version: previous.name.slice(1), tag: previous.name, reused: true };
  const latest = versions[0];
  // 公開に至らなかったタグも予約済みとして扱い、別コミットで再利用しない。
  const version = !latest || compare(base, latest.parts) > 0 ? baseVersion : increment(latest.parts);
  return { version, tag: `v${version}`, reused: false };
}

/** Set the build version; existing releases are verified after rebuilding assets. */
export async function prepareRelease({ root, tags, commit, getRelease }) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = planRelease(manifest.version, tags, commit);
  const release = await getRelease(plan.tag);
  if (release) {
    assert.equal(release.tag_name, plan.tag, "Releaseのタグが一致しません");
    if (release.draft) {
      // ghはタグ作成より前にdraftを残す場合がある。SHAが一致するときだけ再開する。
      assert.equal(release.target_commitish, commit, "下書きReleaseのコミットが一致しません");
    } else {
      assert(plan.reused, "採番中に同名のReleaseが作成されました。ワークフローを再実行してください");
    }
  }
  manifest.version = plan.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...plan, exists: Boolean(release) };
}
