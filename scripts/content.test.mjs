import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const source = await readFile(process.env.FORCE_TRANSLATE_CONTENT_SOURCE ?? new URL("../src/content.ts", import.meta.url), "utf8");
const script = new Script(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText);

async function waitFor(predicate, message = "処理が完了しませんでした") {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

function languageOf(text) {
  if (/[ぁ-んァ-ン]/u.test(text)) return "ja";
  if (/Bonjour|Merci/.test(text)) return "fr";
  if (text === "Hi 👋") return "und";
  return "en";
}

function fixture(t, { html = "", lang = "ja", url = "https://discord.com/channels/server/channel", detect = languageOf, translate, availability } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="${lang}" translate="no"><body>${html}</body></html>`, {
    url, runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  const detections = [];
  const errors = [];
  const alerts = [];
  let listener;
  window.chrome = {
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      sendMessage: async () => ({}),
    },
    storage: { local: { get: async () => ({}) } },
    i18n: { detectLanguage: async (text) => {
      detections.push(text);
      return { isReliable: true, languages: [{ language: await detect(text), percentage: 100 }] };
    } },
  };
  window.Translator = {
    availability: async ({ sourceLanguage }) => availability?.(sourceLanguage) ?? "available",
    create: async ({ sourceLanguage }) => ({ translate: async (text) => {
      calls.push({ language: sourceLanguage, text });
      return translate ? translate(text, sourceLanguage) : `翻訳(${sourceLanguage}):${text}`;
    } }),
  };
  window.console.error = (...args) => errors.push(args);
  window.alert = (message) => alerts.push(message);
  script.runInContext(dom.getInternalVMContext());
  return {
    window, document: window.document, calls, detections, errors, alerts,
    start: () => listener({ type: "FT_START_TRANSLATION" }, {}, () => {}),
    stop: () => listener({ type: "FT_RESTORE_ORIGINAL" }, {}, () => {}),
    status: () => new Promise((resolve) => listener({ type: "FT_GET_STATUS" }, {}, resolve)),
  };
}

test("Discordの日本語UIでも投稿ごとに翻訳し、DOM構造と入力・コード・日本語を保つ", async (t) => {
  const f = fixture(t, { html: `
    <nav>受信ボックスとチャンネル一覧</nav>
    <div id="message-content-1" class="notranslate"><span>Hello </span><strong>everyone</strong><span>, welcome!</span><code>read_file</code></div>
    <div id="message-content-2">日本語の投稿です</div>
    <div contenteditable="true"><div id="message-content-draft">Do not change this draft.</div></div>
    <pre>Do not change this code.</pre>` });
  const message = f.document.getElementById("message-content-1");
  const elements = [...message.children];
  const textNodes = elements.map((el) => el.firstChild);
  const status = await f.status();
  assert.equal(status.sourceLanguage, "en");
  assert.deepEqual([...status.sourceLanguages], ["en"]);
  f.start();
  await waitFor(() => f.calls.length === 3 && message.textContent.includes("翻訳"));
  assert.deepEqual([...message.children], elements);
  assert.deepEqual(elements.map((el) => el.firstChild), textNodes);
  assert.equal(message.querySelector("code").textContent, "read_file");
  assert.equal(f.document.getElementById("message-content-2").textContent, "日本語の投稿です");
  assert.equal(f.document.querySelector("[contenteditable]").textContent, "Do not change this draft.");
  assert.equal(f.document.querySelector("nav").textContent, "受信ボックスとチャンネル一覧");
  assert.ok(f.detections.includes("Hello\neveryone\n, welcome!"));
  assert.deepEqual([...(await f.status()).sourceLanguages], ["en"], "翻訳後も原文からモデルを判定する");
  f.start();
  await delay(230);
  assert.equal(f.calls.length, 3, "翻訳済みの文章を再翻訳しない");
  f.stop();
  assert.equal(message.textContent, "Hello everyone, welcome!read_file");
  assert.equal((await f.status()).active, false);
  assert.equal(f.errors.length, 0);
});

test("UIの言語や他の投稿に引きずられず、複数の言語を用意する", async (t) => {
  const f = fixture(t, { lang: "en-US", html: `
    <div id="message-content-1">${"日本語の長いお知らせです。".repeat(350)}</div>
    <div id="message-content-2">Bonjour tout le monde!</div>
    <div id="message-content-3">Hello everyone!</div>` });
  assert.deepEqual(new Set((await f.status()).sourceLanguages), new Set(["en", "fr"]));
  f.start();
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls, [
    { language: "fr", text: "Bonjour tout le monde!" },
    { language: "en", text: "Hello everyone!" },
  ]);
});

test("Discordのリンクプレビューを本文とは別に翻訳し、リンク・コード・画像操作を保つ", async (t) => {
  const f = fixture(t, { html: `
    <div id="message-content-1">こちらの資料を見てください</div>
    <div id="message-accessories-1">
      <article id="english-preview">
        <div>Example Docs</div>
        <a href="https://example.com/guide" target="_blank" rel="noreferrer noopener">Environment definition</a>
        <div class="description">Understand the environment definition schema.</div>
        <div><strong>Requirements</strong><span>Use a supported environment.</span><code>setup.sh</code></div>
        <div role="button" aria-label="Environment definition"><img alt="Environment definition"><span>画像を読み込めませんでした。</span></div>
        <button>プレビューを閉じる</button>
      </article>
      <article id="japanese-preview"><a href="https://example.com/ja">日本語の資料</a><div>設定についての説明です。</div></article>
      <article id="french-preview"><a href="https://example.com/fr">Bonjour tout le monde!</a><div>Merci beaucoup.</div></article>
      <div role="group"><span>リアクションを付ける</span></div>
      <div role="button" id="thread">A discussion thread</div>
      <a id="attachment" href="https://example.com/file">notes.txt</a>
    </div>` });
  const preview = f.document.getElementById("english-preview");
  const link = preview.querySelector("a");
  const linkNode = link.firstChild;
  const elements = [...preview.querySelectorAll("*")];
  const original = f.document.body.textContent;
  assert.deepEqual(new Set((await f.status()).sourceLanguages), new Set(["en", "fr"]), "本文が日本語でもプレビュー用のモデルを準備する");
  f.start();
  await waitFor(() => f.document.querySelector("#french-preview div").textContent.startsWith("翻訳"));
  assert.equal(link.textContent, "翻訳(en):Environment definition");
  assert.equal(preview.querySelector(".description").textContent, "翻訳(en):Understand the environment definition schema.");
  assert.equal(preview.querySelector("strong").textContent, "翻訳(en):Requirements");
  assert.equal(preview.querySelector("code").textContent, "setup.sh");
  assert.equal(preview.querySelector("[role=button]").textContent, "画像を読み込めませんでした。");
  assert.equal(preview.querySelector("button").textContent, "プレビューを閉じる");
  assert.equal(preview.querySelector("[role=button]").getAttribute("aria-label"), "Environment definition");
  assert.equal(link.getAttribute("href"), "https://example.com/guide");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer noopener");
  assert.equal(link.firstChild, linkNode);
  assert.deepEqual([...preview.querySelectorAll("*")], elements);
  assert.equal(f.document.getElementById("message-content-1").textContent, "こちらの資料を見てください");
  assert.equal(f.document.getElementById("japanese-preview").textContent, "日本語の資料設定についての説明です。");
  assert.equal(f.document.getElementById("thread").textContent, "A discussion thread");
  assert.equal(f.document.getElementById("attachment").textContent, "notes.txt");
  assert.deepEqual(new Set((await f.status()).sourceLanguages), new Set(["en", "fr"]));
  assert.equal(f.calls.length, 7);
  f.stop();
  assert.equal(f.document.body.textContent, original);
  assert.equal(f.errors.length, 0);
});

test("遅れて読み込まれたリンクプレビューの追加・編集・差し替えを翻訳する", async (t) => {
  const f = fixture(t, { html: '<div id="message-content-1">https://example.com/guide</div><div id="message-accessories-1"></div>' });
  assert.deepEqual([...(await f.status()).sourceLanguages], []);
  f.start();
  const accessories = f.document.getElementById("message-accessories-1");
  const preview = f.document.createElement("article");
  preview.innerHTML = '<a href="https://example.com/guide">A guide to environments</a><div>Prepare your development environment.</div>';
  accessories.append(preview);
  const title = preview.querySelector("a");
  await waitFor(() => title.textContent === "翻訳(en):A guide to environments");
  title.firstChild.data = "An updated guide to environments";
  await waitFor(() => title.textContent === "翻訳(en):An updated guide to environments");
  preview.innerHTML = '<a href="https://example.com/fr">Bonjour tout le monde!</a><div>Merci beaucoup.</div>';
  await waitFor(() => preview.querySelector("div").textContent === "翻訳(fr):Merci beaucoup.");
  assert.deepEqual([...(await f.status()).sourceLanguages], ["fr"]);
  assert.equal(f.calls.length, 5);
  f.stop();
  assert.equal(preview.textContent, "Bonjour tout le monde!Merci beaucoup.");
  assert.equal(f.document.getElementById("message-content-1").textContent, "https://example.com/guide");
});

test("読み込み前に開始しても、新着・編集・TextNode交換・チャンネル移動に追従する", async (t) => {
  const f = fixture(t, { html: "<nav>読み込み中です</nav><main></main>" });
  await f.status();
  f.start();
  const main = f.document.querySelector("main");
  const message = f.document.createElement("div");
  message.id = "message-content-1";
  message.textContent = "The first message has arrived.";
  main.append(message);
  await waitFor(() => message.textContent.startsWith("翻訳"));
  message.firstChild.data = "The message was edited.";
  await waitFor(() => message.textContent === "翻訳(en):The message was edited.");
  message.textContent = "React replaced the text node.";
  await waitFor(() => message.textContent === "翻訳(en):React replaced the text node.");
  f.window.history.pushState({}, "", "/channels/server/french");
  const next = f.document.createElement("div");
  next.id = "message-content-2";
  next.textContent = "Bonjour tout le monde!";
  main.replaceChildren(next);
  await waitFor(() => next.textContent === "翻訳(fr):Bonjour tout le monde!");
  assert.deepEqual([...(await f.status()).sourceLanguages], ["fr"]);
  assert.equal(f.calls.length, 4);
  f.stop();
  assert.equal(next.textContent, "Bonjour tout le monde!");
});

test("短い英語はundでも翻訳し、判定不能の日本語や絵文字は変更しない", async (t) => {
  const f = fixture(t, { html: `
    <div id="message-content-1">Hi 👋</div>
    <div id="message-content-2">こんにちは</div>
    <div id="message-content-3">👋</div>`, detect: () => "und" });
  f.start();
  await waitFor(() => f.calls.length === 1);
  assert.deepEqual(f.calls, [{ language: "en", text: "Hi 👋" }]);
});

test("原文復元の後に完了した翻訳を反映しない", async (t) => {
  let complete;
  const f = fixture(t, { html: '<div id="message-content-1">Hello everyone!</div>', translate: () => new Promise((resolve) => { complete = resolve; }) });
  f.start();
  await waitFor(() => complete);
  f.stop();
  complete("皆さん、こんにちは！");
  await delay(30);
  assert.equal(f.document.body.textContent, "Hello everyone!");
  assert.equal((await f.status()).active, false);
});

test("翻訳中の編集に古い結果を上書きせず、最新の原文を復元する", async (t) => {
  let complete;
  const f = fixture(t, { html: '<div id="message-content-1">The old message.</div>', translate: (text) => text === "The old message."
    ? new Promise((resolve) => { complete = resolve; }) : `翻訳:${text}` });
  const node = f.document.getElementById("message-content-1").firstChild;
  f.start();
  await waitFor(() => complete);
  node.data = "The edited message.";
  complete("古いメッセージ");
  await waitFor(() => node.data === "翻訳:The edited message.");
  f.stop();
  assert.equal(node.data, "The edited message.");
});

test("翻訳モデルが未準備の言語があっても、準備済みの言語は翻訳する", async (t) => {
  const f = fixture(t, { html: `
    <div id="message-content-1">Hello everyone!</div>
    <div id="message-content-2">Bonjour tout le monde!</div>`, availability: (language) => language === "en" ? "downloadable" : "available" });
  f.start();
  await waitFor(() => f.alerts.length === 1);
  assert.equal(f.document.getElementById("message-content-1").textContent, "Hello everyone!");
  assert.equal(f.document.getElementById("message-content-2").textContent, "翻訳(fr):Bonjour tout le monde!");
  assert.equal((await f.status()).sourceLanguage, "en");
});

test("チャットでDOM更新が続いても新着の翻訳を先送りし続けない", async (t) => {
  const f = fixture(t, { html: '<div id="ticker">0</div><main></main>' });
  f.start();
  const ticker = f.document.getElementById("ticker").firstChild;
  let count = 0;
  const timer = setInterval(() => { ticker.data = String(++count); }, 30);
  t.after(() => clearInterval(timer));
  const message = f.document.createElement("div");
  message.id = "message-content-1";
  message.textContent = "A new message in a busy channel.";
  f.document.querySelector("main").append(message);
  await waitFor(() => message.textContent.startsWith("翻訳"));
  assert.ok(count > 0);
});

test("通常のサイトの翻訳・復元・除外ルールを維持する", async (t) => {
  const f = fixture(t, { url: "https://example.com/", lang: "en", html: `
    <p class="notranslate">An ordinary English page.</p>
    <pre>Preserve this code.</pre><textarea>Preserve this draft.</textarea>` });
  f.start();
  await waitFor(() => f.document.querySelector("p").textContent.startsWith("翻訳"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.querySelector("pre").textContent, "Preserve this code.");
  assert.equal(f.document.querySelector("textarea").value, "Preserve this draft.");
  f.stop();
  assert.equal(f.document.querySelector("p").textContent, "An ordinary English page.");
});
