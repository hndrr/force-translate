import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("../src/popup.ts", import.meta.url), "utf8");
const script = new Script(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText);

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "ポップアップの処理が完了しませんでした");
    await delay(10);
  }
}

test("複数の翻訳モデルをクリック中に全て準備し、完了後に翻訳を開始する", async (t) => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/popup.html" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  const messages = [];
  const destroyed = [];
  window.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: "https://discord.com/channels/server/channel" }],
      sendMessage: async (_id, message) => {
        messages.push(message.type);
        return { ok: true, active: messages.includes("FT_START_TRANSLATION"), origin: "https://discord.com", sourceLanguage: "en", sourceLanguages: ["en", "fr", "en", "ja"] };
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  window.Translator = { create: ({ sourceLanguage }) => new Promise((resolve) => {
    requests.push({ sourceLanguage, resolve: () => resolve({ destroy: () => destroyed.push(sourceLanguage) }) });
  }) };
  script.runInContext(dom.getInternalVMContext());
  const button = window.document.querySelector("#translateButton");
  await waitFor(() => !button.disabled);
  button.click();
  assert.deepEqual(requests.map(({ sourceLanguage }) => sourceLanguage), ["en", "fr"], "最初のawaitより前に両方のモデルを要求する");
  requests[0].resolve();
  await delay(10);
  assert.ok(!messages.includes("FT_START_TRANSLATION"));
  requests[1].resolve();
  await waitFor(() => window.document.querySelector("#message").textContent === "翻訳を開始しました");
  assert.deepEqual(destroyed, ["en", "fr"]);
  assert.ok(messages.includes("FT_START_TRANSLATION"));
  assert.equal(window.document.querySelector("#progressBar").style.width, "100%");
  assert.equal(window.document.querySelector("#stateBadge").textContent, "翻訳中");
});
