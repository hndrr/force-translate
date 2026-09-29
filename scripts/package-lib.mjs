import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { zipSync, unzipSync } from "fflate";

const baseFiles = ["manifest.json", "background.js", "content.js", "popup.html", "popup.css", "popup.js"];

function localPath(value) {
  assert.equal(typeof value, "string", "ファイルパスは文字列で指定してください");
  assert(value && !value.includes("\\") && !value.includes(":") && !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== ".."),
  `安全な相対パスではありません: ${value}`);
  return value;
}

export async function collectFiles(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, "Manifest V3が必要です");
  assert(typeof manifest.name === "string" && manifest.name.trim(), "拡張名が必要です");
  assert(typeof manifest.description === "string" && manifest.description.length > 0 &&
    manifest.description.length <= 132, "説明は1〜132文字で指定してください");
  assert(typeof manifest.version === "string" && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(manifest.version) &&
    manifest.version.split(".").every((part) => Number(part) <= 65535) &&
    manifest.version.split(".").some((part) => Number(part) > 0), "拡張のバージョン番号が不正です");

  const icons = [
    ...Object.entries(manifest.icons ?? {}),
    ...Object.entries(typeof manifest.action?.default_icon === "object" ? manifest.action.default_icon : {}),
    ...(typeof manifest.action?.default_icon === "string" ? [[null, manifest.action.default_icon]] : []),
  ];
  const names = new Set(baseFiles);
  for (const [, value] of icons) names.add(localPath(value));
  const references = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ].filter(Boolean);
  // 意図しないソースや秘密ファイルを含めないよう、実行用ファイルは明示的に管理する。
  for (const reference of references) {
    assert(names.has(localPath(reference)), `配布対象への追加が必要です: ${reference}`);
  }
  const files = {};
  for (const name of [...names].sort()) {
    files[name] = new Uint8Array(await readFile(path.join(root, name)));
    if (name.endsWith(".js")) {
      new Script(Buffer.from(files[name]).toString("utf8"), { filename: name });
    }
  }
  const html = Buffer.from(files["popup.html"]).toString("utf8");
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    assert(names.has(localPath(match[1])), `ポップアップの参照先が配布対象にありません: ${match[1]}`);
  }
  const css = Buffer.from(files["popup.css"]).toString("utf8");
  assert(!/@import\b/i.test(css), "CSSの@importは配布対象を明示してから使用してください");
  for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
    if (match[1].startsWith("data:")) continue;
    assert(names.has(localPath(match[1])), `CSSの参照先が配布対象にありません: ${match[1]}`);
  }
  for (const [size, name] of icons) {
    const data = Buffer.from(files[name]);
    assert(data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      `アイコンはPNGで指定してください: ${name}`);
    if (size !== null) {
      assert(data.readUInt32BE(16) === Number(size) && data.readUInt32BE(20) === Number(size),
        `アイコンの寸法が${size}x${size}ではありません: ${name}`);
    }
  }
  return { manifest, files };
}

export function createArchive(files) {
  // 同じ入力から同じZIPを作れるよう、エントリの日時を固定する。
  const entries = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => [name, [data, { mtime: new Date(2000, 0, 1) }]]));
  const zip = zipSync(entries, { level: 9 });
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(files).sort());
  for (const [name, data] of Object.entries(files)) assert.deepEqual(unpacked[name], data);
  return zip;
}
