import assert from "node:assert/strict";
import test from "node:test";
import { publishRelease } from "./release-publish.mjs";

const tag = "v0.5.1";
const commit = "source-commit";
const files = {
  "force-translate-0.5.1.zip": Buffer.from("zip bytes"),
  "force-translate-0.5.1.zip.sha256": Buffer.from("checksum bytes"),
  "release-checklist.md": Buffer.from("report bytes"),
};

/** Simulate remote state so interrupted uploads persist between attempts. */
function fixture({ draft = true, target = commit, tagCommit = commit, present = {}, absent = false } = {}) {
  let release = absent ? null : { tag_name: tag, target_commitish: target, draft, assets: [] };
  const bytes = new Map();
  const events = [];
  let nextId = 1;
  const put = (name, data) => {
    const asset = { id: nextId++, name, state: "uploaded" };
    release.assets = release.assets.filter((entry) => entry.name !== name);
    release.assets.push(asset);
    bytes.set(asset.id, data);
  };
  for (const [name, data] of Object.entries(present)) put(name, data);
  const api = {
    getRelease: async () => structuredClone(release),
    getTagCommit: async () => tagCommit,
    getAssetBytes: async (asset) => bytes.get(asset.id),
    createDraft: async () => {
      events.push("create");
      release = { tag_name: tag, target_commitish: commit, draft: true, assets: [] };
    },
    uploadAsset: async (_tag, name) => { events.push(`upload:${name}`); put(name, files[name]); },
    publishDraft: async () => { events.push("publish"); release.draft = false; tagCommit = commit; },
  };
  return { api, events, put };
}

test("アップロード中断後の再実行で一致するファイルを保ち、不足分だけを追加して公開する", async () => {
  const { api, events } = fixture({ absent: true, tagCommit: null });
  const upload = api.uploadAsset;
  let count = 0;
  api.uploadAsset = async (...args) => {
    if (++count === 2) throw new Error("interrupted");
    await upload(...args);
  };
  await assert.rejects(publishRelease({ tag, commit, files, api }), /interrupted/);
  assert(!events.includes("publish"));
  api.uploadAsset = upload;
  assert.equal(await publishRelease({ tag, commit, files, api }), "published");
  assert.equal(events.filter((event) => event === "create").length, 1);
  assert.equal(events.filter((event) => event === "upload:force-translate-0.5.1.zip").length, 1);
  assert.equal(events.at(-1), "publish");
});

test("draft内の壊れたファイルを置き換え、バイト列確認後に公開する", async () => {
  const { api, events } = fixture({ present: { ...files, "force-translate-0.5.1.zip": Buffer.from("wrong") } });
  assert.equal(await publishRelease({ tag, commit, files, api }), "published");
  assert.deepEqual(events, ["upload:force-translate-0.5.1.zip", "publish"]);
});

test("公開済みのコミットと全添付ファイルが一致すれば書き換えない", async () => {
  const { api, events } = fixture({ draft: false, present: files });
  assert.equal(await publishRelease({ tag, commit, files, api }), "verified");
  assert.deepEqual(events, []);
});

test("公開済みの添付ファイル欠落・不一致を成功扱いにしない", async () => {
  for (const present of [{}, { ...files, "release-checklist.md": Buffer.from("wrong") }]) {
    const { api, events } = fixture({ draft: false, present });
    await assert.rejects(publishRelease({ tag, commit, files, api }), /不完全または不一致/);
    assert.deepEqual(events, []);
  }
});

test("別コミットのdraftやタグを変更せず停止する", async () => {
  for (const options of [{ target: "other" }, { tagCommit: "other" }, { draft: false, tagCommit: "other", present: files }]) {
    const { api, events } = fixture(options);
    await assert.rejects(publishRelease({ tag, commit, files, api }), /コミット/);
    assert.deepEqual(events, []);
  }
});

test("想定外の添付ファイルがあるdraftを公開しない", async () => {
  const { api, events } = fixture({ present: { "unexpected.zip": Buffer.from("unknown") } });
  await assert.rejects(publishRelease({ tag, commit, files, api }), /想定外/);
  assert.deepEqual(events, []);
});

test("アップロード後の内容が不一致なら公開しない", async () => {
  const { api, events, put } = fixture();
  api.uploadAsset = async (_tag, name) => put(name, Buffer.from("corrupt"));
  await assert.rejects(publishRelease({ tag, commit, files, api }), /再検証/);
  assert(!events.includes("publish"));
});
