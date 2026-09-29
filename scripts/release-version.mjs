import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every((part) => part <= 65535) && parts.some((part) => part > 0) ? parts : null;
}

function compare(left, right) {
  for (let i = 0; i < 4; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

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

export async function prepareRelease({ root, tags, commit, getRelease }) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = planRelease(manifest.version, tags, commit);
  const release = await getRelease(plan.tag);
  if (release) {
    assert(plan.reused, "採番中に同名のReleaseが作成されました。ワークフローを再実行してください");
    assert(!release.draft, "同名の下書きReleaseが存在します。公開状態を確認してください");
    return { ...plan, exists: true };
  }
  manifest.version = plan.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...plan, exists: false };
}
