import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, projectRoot } from "./build.mjs";
import { collectFiles, createArchive } from "./package-lib.mjs";

await build();
const { manifest, files } = await collectFiles(projectRoot);
const archive = createArchive(files);
const dist = path.join(projectRoot, "dist");
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(path.join(dist, ".package-"));
try {
  const extension = path.join(staging, "extension");
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(extension, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const zipName = `force-translate-${manifest.version}.zip`;
  const sha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(path.join(staging, zipName), archive);
  await writeFile(path.join(staging, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);
  const report = `# 提出前の確認\n\n` +
    `対象: ${manifest.name} ${manifest.version}\n\n` +
    `## 自動確認済み\n\n` +
    `- TypeScriptの型チェックとビルド\n- JavaScriptの構文チェック（通常のスクリプトとして読み込み可能）\n` +
    `- manifestの基本項目と実行ファイル・ポップアップの参照先\n` +
    `- manifest.jsonがZIP直下にあること\n- ZIPを展開した内容が元ファイルと一致すること\n\n` +
    `## 公開前に必要な作業\n\n` +
    (manifest.icons?.["128"] ? `- [x] 128pxの拡張アイコンを同梱\n` :
      `- [ ] 128x128 PNGの拡張アイコンを用意してmanifest.jsonのiconsに登録（16・32・48pxも推奨）。登録後に再パッケージ化\n`) +
    `- [ ] 実際のChromeでdist/extensionを読み込み、翻訳・原文復元・自動翻訳・初回モデル取得を確認\n` +
    `- [ ] スクリーンショット（1280x800または640x400）と小さいプロモーション画像（440x280）を用意\n` +
    `- [ ] store/listing.ja.mdの説明・権限理由を確認\n` +
    `- [ ] store/privacy-policy.ja.mdの内容を確認し、問い合わせ先を追記して公開URLを用意\n` +
    `- [ ] 開発者アカウントの登録、ストア情報・プライバシー項目の入力、ZIPのアップロードと審査申請\n\n` +
    `自動確認はChrome上での動作やストア審査の通過を保証するものではありません。\n\n` +
    `## ZIP内のファイル\n\n${Object.keys(files).map((name) => `- ${name}`).join("\n")}\n\n` +
    `SHA-256: ${sha256}\n`;
  await writeFile(path.join(staging, "release-checklist.md"), report);
  // 毎回作り直し、以前のビルドの余分なファイルを引き継がない。
  await rm(path.join(dist, "extension"), { recursive: true, force: true });
  await rename(extension, path.join(dist, "extension"));
  for (const name of [zipName, `${zipName}.sha256`, "release-checklist.md"]) {
    await rename(path.join(staging, name), path.join(dist, name));
  }
  console.log(`配布用ZIP: dist/${zipName}\n動作確認用: dist/extension\n提出前の確認: dist/release-checklist.md`);
  if (!manifest.icons?.["128"]) console.log("未準備: ストア提出に必要な128pxアイコン。詳細は確認リストを参照してください。");
} finally {
  await rm(staging, { recursive: true, force: true });
}
