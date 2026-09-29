import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Hash the actual downloaded bytes instead of trusting asset names or sizes. */
function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Verify release ownership, including drafts created before their Git tag. */
async function checkTarget(api, release, tag, commit) {
  assert.equal(release.tag_name, tag, "Releaseのタグが一致しません");
  const tagCommit = await api.getTagCommit(tag);
  if (release.draft) {
    assert.equal(release.target_commitish, commit, "下書きReleaseのコミットが一致しません");
    assert(tagCommit === null || tagCommit === commit, "タグが別のコミットを指しています");
  } else {
    assert.equal(tagCommit, commit, "公開済みReleaseのタグが別のコミットを指しています");
  }
}

/** Return required assets that are missing, incomplete, or bytewise different. */
async function inspectAssets(api, release, files) {
  const assets = release.assets ?? [];
  const names = assets.map((asset) => asset.name);
  assert.equal(new Set(names).size, names.length, "Releaseに同名の添付ファイルが複数あります");
  assert(names.every((name) => Object.hasOwn(files, name)), "Releaseに想定外の添付ファイルがあります");
  const pending = [];
  for (const [name, bytes] of Object.entries(files)) {
    const asset = assets.find((item) => item.name === name);
    if (!asset || asset.state !== "uploaded" || digest(await api.getAssetBytes(asset)) !== digest(bytes)) {
      pending.push(name);
    }
  }
  return pending;
}

/** Resume matching drafts, verify all assets, and never rewrite published releases. */
export async function publishRelease({ tag, commit, files, api }) {
  assert(Object.keys(files).length > 0, "公開する添付ファイルが必要です");
  let release = await api.getRelease(tag);
  if (!release) {
    const tagCommit = await api.getTagCommit(tag);
    assert(tagCommit === null || tagCommit === commit, "タグが別のコミットを指しています");
    await api.createDraft(tag, commit);
    release = await api.getRelease(tag);
  }
  assert(release, "Releaseが見つかりません");
  await checkTarget(api, release, tag, commit);
  const pending = await inspectAssets(api, release, files);
  if (!release.draft) {
    assert.equal(pending.length, 0, `公開済みReleaseの添付ファイルが不完全または不一致です: ${pending.join(", ")}`);
    return "verified";
  }
  for (const name of pending) await api.uploadAsset(tag, name);
  release = await api.getRelease(tag);
  assert(release?.draft, "検証中にReleaseの公開状態が変更されました");
  await checkTarget(api, release, tag, commit);
  assert.equal((await inspectAssets(api, release, files)).length, 0, "添付ファイルの再検証に失敗しました");
  await api.publishDraft(tag);
  release = await api.getRelease(tag);
  assert(release && !release.draft, "Releaseを公開できませんでした");
  await checkTarget(api, release, tag, commit);
  assert.equal((await inspectAssets(api, release, files)).length, 0, "公開後の添付ファイル検証に失敗しました");
  return "published";
}
