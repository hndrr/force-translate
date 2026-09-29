namespace ForceTranslateContent {
  const TARGET_LANGUAGE = "ja";
  const STORAGE_AUTO_ORIGINS = "autoTranslateOrigins";
  const MAX_SAMPLE_LENGTH = 3000;
  const MAX_TRANSLATION_CHUNK = 2200;
  const BATCH_SIZE = 20;
  const MUTATION_DEBOUNCE_MS = 180;
  const SHADOW_SCAN_INTERVAL_MS = 1800;

  const SUPPORTED_LANGUAGES = new Set([
    "ar", "bg", "bn", "cs", "da", "de", "el", "en", "es", "fi", "fr",
    "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "mr",
    "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "ta", "te",
    "th", "tr", "uk", "vi", "zh", "zh-Hant",
  ]);

  // サイト側の translate="no" / .notranslate は意図的に見ない。
  // DOM構造を壊しやすい要素と、入力・コードだけを除外する。
  const EXCLUDED_SELECTOR = [
    "script", "style", "noscript", "template",
    "code", "pre", "kbd", "samp",
    "textarea", "select", "option",
    "[contenteditable='true']", "[contenteditable='']",
  ].join(",");

  type TranslationRecord = {
    original: string;
    translated: string;
    version: number;
  };

  type BatchSuccess = { ok: true; results: string[] };
  type BatchFailure = { ok: false; code: string; message: string };
  type BatchResponse = BatchSuccess | BatchFailure;

  type IncomingMessage =
    | { type: "FT_START_TRANSLATION" }
    | { type: "FT_RESTORE_ORIGINAL" }
    | { type: "FT_GET_STATUS" }
    | { type: "FT_TRANSLATE_PROXY_BATCH"; sourceLanguage: string; texts: string[] };

  class ActivationRequiredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ActivationRequiredError";
    }
  }

  class AiUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AiUnavailableError";
    }
  }

  const isTopFrame = window === window.top;
  const translations = new Map<Text, TranslationRecord>();
  const observedRoots = new Set<Document | ShadowRoot>();
  const pendingRoots = new Set<Node>();
  const translationCache = new Map<string, string>();
  const translatorPromises = new Map<string, Promise<TranslatorInstance>>();

  let active = false;
  let runVersion = 0;
  let sourceLanguageCache: string | null | undefined;
  let mutationTimer: number | null = null;
  let shadowScanTimer: number | null = null;
  let aiQueue: Promise<void> = Promise.resolve();
  let lastErrorMessage = "";
  let lastErrorAt = 0;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isIncomingMessage(value: unknown): value is IncomingMessage {
    return isRecord(value) && typeof value.type === "string";
  }

  function normalizeLanguage(code: string | null | undefined): string | null {
    if (!code) return null;
    const normalized = code.trim().replace("_", "-");
    if (!normalized) return null;
    if (/^zh-(tw|hk|mo|hant)/i.test(normalized)) return "zh-Hant";
    const base = normalized.split("-")[0]?.toLowerCase() ?? "";
    return SUPPORTED_LANGUAGES.has(base) ? base : null;
  }

  function pageOrigin(): string | null {
    try {
      if (location.protocol !== "http:" && location.protocol !== "https:") return null;
      return location.origin;
    } catch {
      return null;
    }
  }

  function enqueueAiTask<T>(task: () => Promise<T>): Promise<T> {
    const next = aiQueue.then(task, task);
    aiQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function notifyError(error: unknown): void {
    if (!isTopFrame) return;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (message === lastErrorMessage && now - lastErrorAt < 5000) return;
    lastErrorMessage = message;
    lastErrorAt = now;
    console.error("[Force Translate]", error);

    // ページDOMに通知要素を挿入しない。Reactの管理DOMを構造変更しないため。
    // 初回モデル準備が必要なケースだけ、ユーザーに次の操作を明示する。
    if (error instanceof ActivationRequiredError) {
      window.alert(
        "Force Translate: 翻訳モデルの準備が必要です。\n" +
          "ChromeツールバーのForce Translateアイコンを開き、『このページを翻訳』を押してください。",
      );
      return;
    }

    if (error instanceof AiUnavailableError) {
      window.alert(`Force Translate: ${message}`);
    }
  }

  function createTranslatorFromGesture(sourceLanguage: string): Promise<TranslatorInstance> {
    const existing = translatorPromises.get(sourceLanguage);
    if (existing) return existing;
    if (!("Translator" in globalThis)) {
      return Promise.reject(new AiUnavailableError("このChromeではTranslator APIが利用できません"));
    }

    let promise: Promise<TranslatorInstance>;
    try {
      // contextmenu/mousedownの同期ハンドラ内から開始する。
      // モデル未取得時のuser activationを失わないためavailability()を先にawaitしない。
      promise = Translator.create({
        sourceLanguage,
        targetLanguage: TARGET_LANGUAGE,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            console.info(
              `[Force Translate] ${sourceLanguage}->ja model ${Math.round(event.loaded * 100)}%`,
            );
          });
        },
      });
    } catch (error) {
      return Promise.reject(error);
    }

    translatorPromises.set(sourceLanguage, promise);
    promise.catch(() => translatorPromises.delete(sourceLanguage));
    return promise;
  }

  async function ensureTranslator(sourceLanguage: string): Promise<TranslatorInstance> {
    const existing = translatorPromises.get(sourceLanguage);
    if (existing) return existing;
    if (!("Translator" in globalThis)) {
      throw new AiUnavailableError("このChromeではTranslator APIが利用できません");
    }

    const options = { sourceLanguage, targetLanguage: TARGET_LANGUAGE };
    const availability = await Translator.availability(options);
    if (availability === "unavailable") {
      throw new AiUnavailableError(`${sourceLanguage} → ja の翻訳モデルを利用できません`);
    }
    if (availability === "downloadable" || availability === "downloading") {
      throw new ActivationRequiredError("Chrome内蔵の翻訳モデルを準備する必要があります");
    }

    const promise = Translator.create(options);
    translatorPromises.set(sourceLanguage, promise);
    promise.catch(() => translatorPromises.delete(sourceLanguage));
    return promise;
  }

  async function detectLanguage(sample: string): Promise<string | null> {
    const clean = sample.trim().slice(0, MAX_SAMPLE_LENGTH);
    if (!clean) return null;
    try {
      const result = await chrome.i18n.detectLanguage(clean);
      const best = result.languages.find((item) => normalizeLanguage(item.language));
      return normalizeLanguage(best?.language);
    } catch {
      return null;
    }
  }

  function splitLongText(text: string): string[] {
    if (text.length <= MAX_TRANSLATION_CHUNK) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > MAX_TRANSLATION_CHUNK) {
      let cut = rest.lastIndexOf("\n", MAX_TRANSLATION_CHUNK);
      if (cut < MAX_TRANSLATION_CHUNK * 0.55) {
        cut = rest.lastIndexOf(". ", MAX_TRANSLATION_CHUNK);
        if (cut > 0) cut += 1;
      }
      if (cut < MAX_TRANSLATION_CHUNK * 0.55) cut = MAX_TRANSLATION_CHUNK;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  function preserveOuterWhitespace(original: string, translatedCore: string): string {
    const leading = original.match(/^\s*/u)?.[0] ?? "";
    const trailing = original.match(/\s*$/u)?.[0] ?? "";
    return `${leading}${translatedCore.trim()}${trailing}`;
  }

  async function translateOne(
    translator: TranslatorInstance,
    sourceLanguage: string,
    text: string,
  ): Promise<string> {
    const cacheKey = `${sourceLanguage}\u0000${text}`;
    const cached = translationCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const core = text.trim();
    if (!core) return text;
    const parts = splitLongText(core);
    const translatedParts: string[] = [];
    for (const part of parts) translatedParts.push(await translator.translate(part));
    const translated = preserveOuterWhitespace(text, translatedParts.join(""));

    if (translationCache.size >= 3000) {
      const firstKey = translationCache.keys().next().value as string | undefined;
      if (firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, translated);
    return translated;
  }

  async function translateBatchTop(sourceLanguage: string, texts: string[]): Promise<string[]> {
    if (sourceLanguage === TARGET_LANGUAGE) return texts;
    return enqueueAiTask(async () => {
      const translator = await ensureTranslator(sourceLanguage);
      const results: string[] = [];
      for (const text of texts) results.push(await translateOne(translator, sourceLanguage, text));
      return results;
    });
  }

  async function translateBatch(sourceLanguage: string, texts: string[]): Promise<string[]> {
    if (isTopFrame) return translateBatchTop(sourceLanguage, texts);
    const response = await chrome.runtime.sendMessage<BatchResponse>({
      type: "FT_PROXY_TRANSLATE_BATCH",
      sourceLanguage,
      texts,
    });
    if (!response.ok) {
      if (response.code === "activation-required") throw new ActivationRequiredError(response.message);
      if (response.code === "ai-unavailable") throw new AiUnavailableError(response.message);
      throw new Error(response.message);
    }
    return response.results;
  }

  function shouldSkipText(textNode: Text): boolean {
    const trimmed = textNode.data.trim();
    if (!trimmed || !/\p{L}/u.test(trimmed)) return true;
    if (/^(?:https?:\/\/|www\.)\S+$/iu.test(trimmed)) return true;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/iu.test(trimmed)) return true;

    const parent = textNode.parentElement;
    if (!parent) return true;
    return Boolean(parent.closest(EXCLUDED_SELECTOR));
  }

  function collectTextNodes(root: Node): Text[] {
    if (root.nodeType === Node.TEXT_NODE) {
      const text = root as Text;
      return shouldSkipText(text) ? [] : [text];
    }

    const result: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldSkipText(node as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let current: Node | null;
    while ((current = walker.nextNode())) result.push(current as Text);
    return result;
  }

  function collectCandidateNodes(root: Node): Text[] {
    return collectTextNodes(root).filter((node) => {
      const record = translations.get(node);
      if (!record) return true;
      if (node.data === record.translated) return false;

      // React/SPAが同じTextNodeを原文へ戻した・別内容へ更新した。
      // 古い記録を捨て、新しい現在値を原文として再翻訳する。
      translations.delete(node);
      return true;
    });
  }

  function buildLanguageSample(): string {
    const parts: string[] = [];
    let length = 0;
    for (const node of collectTextNodes(document.body ?? document.documentElement)) {
      const text = node.data.trim();
      if (text.length < 8) continue;
      parts.push(text);
      length += text.length;
      if (length >= MAX_SAMPLE_LENGTH) break;
    }
    return parts.join("\n").slice(0, MAX_SAMPLE_LENGTH);
  }

  async function resolveSourceLanguage(): Promise<string | null> {
    if (sourceLanguageCache !== undefined) return sourceLanguageCache;

    const declared = normalizeLanguage(document.documentElement.lang);
    if (declared && declared !== TARGET_LANGUAGE) {
      sourceLanguageCache = declared;
      return declared;
    }

    const detected = await detectLanguage(buildLanguageSample());
    sourceLanguageCache = detected;
    return detected;
  }

  async function translateNodes(nodes: Text[], version: number): Promise<void> {
    if (!nodes.length || !active || version !== runVersion) return;
    const sourceLanguage = await resolveSourceLanguage();
    if (!sourceLanguage || sourceLanguage === TARGET_LANGUAGE) return;

    const candidates: Array<{ node: Text; original: string }> = [];
    for (const node of nodes) {
      if (!node.isConnected || shouldSkipText(node)) continue;
      const original = node.data;
      if (!original.trim()) continue;
      candidates.push({ node, original });
    }

    for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
      if (!active || version !== runVersion) return;
      const batch = candidates.slice(offset, offset + BATCH_SIZE);
      const translated = await translateBatch(sourceLanguage, batch.map((item) => item.original));

      translated.forEach((value, index) => {
        const item = batch[index];
        if (!item || !item.node.isConnected || item.node.data !== item.original) return;
        if (value === item.original) return;

        // 記録を先に置いてからnode.dataだけを書き換える。
        // 要素の追加・ラップ・replaceWith等は一切しない。
        translations.set(item.node, {
          original: item.original,
          translated: value,
          version,
        });
        item.node.data = value;
      });
    }
  }

  const mutationObserver = new MutationObserver((mutations) => {
    if (!active) return;

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target as Text;
        const record = translations.get(node);
        // 自分自身の original -> translated 書き換えは無視する。
        if (record && node.data === record.translated) continue;
        pendingRoots.add(node);
        continue;
      }

      // ReactがtextContent/innerHTML等でTextNodeごと差し替えた場合。
      mutation.addedNodes.forEach((node) => pendingRoots.add(node));
    }

    if (mutationTimer !== null) window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(() => {
      mutationTimer = null;
      if (!active) return;
      const version = runVersion;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      discoverAndObserveShadowRoots(document);

      const nodes = new Set<Text>();
      for (const root of roots) collectCandidateNodes(root).forEach((node) => nodes.add(node));
      void translateNodes([...nodes], version).catch(notifyError);
      pruneDetachedRecords();
    }, MUTATION_DEBOUNCE_MS);
  });

  function observeRoot(root: Document | ShadowRoot): void {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    mutationObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  function discoverAndObserveShadowRoots(root: Document | ShadowRoot | Element): void {
    if (root instanceof Document || root instanceof ShadowRoot) observeRoot(root);
    const elements: Element[] = [];
    if (root instanceof Element) elements.push(root);
    elements.push(...root.querySelectorAll("*"));
    for (const element of elements) {
      if (!element.shadowRoot) continue;
      observeRoot(element.shadowRoot);
      discoverAndObserveShadowRoots(element.shadowRoot);
    }
  }

  function collectAllCandidateNodes(): Text[] {
    const result = new Set<Text>();
    collectCandidateNodes(document).forEach((node) => result.add(node));
    for (const root of observedRoots) {
      if (root instanceof ShadowRoot) collectCandidateNodes(root).forEach((node) => result.add(node));
    }
    return [...result];
  }

  function pruneDetachedRecords(): void {
    for (const node of translations.keys()) {
      if (!node.isConnected) translations.delete(node);
    }
  }

  function startShadowScan(): void {
    if (shadowScanTimer !== null) return;
    shadowScanTimer = window.setInterval(() => {
      if (!active) return;
      const before = observedRoots.size;
      discoverAndObserveShadowRoots(document);
      if (observedRoots.size > before) {
        void translateNodes(collectAllCandidateNodes(), runVersion).catch(notifyError);
      }
      pruneDetachedRecords();
    }, SHADOW_SCAN_INTERVAL_MS);
  }

  function stopObservers(): void {
    mutationObserver.disconnect();
    observedRoots.clear();
    pendingRoots.clear();
    if (mutationTimer !== null) {
      window.clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    if (shadowScanTimer !== null) {
      window.clearInterval(shadowScanTimer);
      shadowScanTimer = null;
    }
  }

  async function startTranslation(): Promise<void> {
    active = true;
    runVersion += 1;
    const version = runVersion;
    sourceLanguageCache = undefined;

    discoverAndObserveShadowRoots(document);
    startShadowScan();
    await translateNodes(collectAllCandidateNodes(), version);
  }

  function restoreOriginal(): void {
    active = false;
    runVersion += 1;
    sourceLanguageCache = undefined;
    stopObservers();

    for (const [node, record] of translations) {
      // React側が既に別文字列へ更新している場合は上書きしない。
      if (node.isConnected && node.data === record.translated) {
        node.data = record.original;
      }
    }
    translations.clear();
  }

  function prewarmTranslatorFromGesture(event: MouseEvent): void {
    if (!isTopFrame || event.button !== 2 || !("Translator" in globalThis)) return;
    const declared = normalizeLanguage(document.documentElement.lang);
    const source = sourceLanguageCache ?? declared;
    if (!source || source === TARGET_LANGUAGE || translatorPromises.has(source)) return;
    void createTranslatorFromGesture(source).catch((error: unknown) => {
      console.warn("[Force Translate] translator prewarm failed", error);
    });
  }

  async function maybeStartAutoTranslate(): Promise<void> {
    if (!isTopFrame) return;
    const origin = pageOrigin();
    if (!origin) return;
    const stored = await chrome.storage.local.get(STORAGE_AUTO_ORIGINS);
    const value = stored[STORAGE_AUTO_ORIGINS];
    const origins = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
    if (origins.includes(origin)) {
      await chrome.runtime.sendMessage({ type: "FT_REQUEST_BROADCAST_START" });
    }
  }

  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
    if (!isIncomingMessage(rawMessage)) return;

    if (rawMessage.type === "FT_START_TRANSLATION") {
      void startTranslation().catch(notifyError);
      return;
    }

    if (rawMessage.type === "FT_RESTORE_ORIGINAL") {
      restoreOriginal();
      return;
    }

    if (rawMessage.type === "FT_GET_STATUS" && isTopFrame) {
      void resolveSourceLanguage()
        .then((sourceLanguage) => {
          sendResponse({
            ok: true,
            active,
            sourceLanguage,
            origin: pageOrigin(),
          });
        })
        .catch(() => {
          sendResponse({
            ok: true,
            active,
            sourceLanguage: null,
            origin: pageOrigin(),
          });
        });
      return true;
    }

    if (rawMessage.type === "FT_TRANSLATE_PROXY_BATCH" && isTopFrame) {
      void translateBatchTop(rawMessage.sourceLanguage, rawMessage.texts)
        .then((results) => sendResponse({ ok: true, results } satisfies BatchSuccess))
        .catch((error: unknown) => {
          const response: BatchFailure = {
            ok: false,
            code:
              error instanceof ActivationRequiredError
                ? "activation-required"
                : error instanceof AiUnavailableError
                  ? "ai-unavailable"
                  : "translation-error",
            message: error instanceof Error ? error.message : String(error),
          };
          sendResponse(response);
          notifyError(error);
        });
      return true;
    }
  });

  if (isTopFrame) {
    // mousedown + contextmenuの両方を見る。ブラウザ/OS差で片方しかactivationを持たない場合に備える。
    window.addEventListener("mousedown", prewarmTranslatorFromGesture, true);
    window.addEventListener("contextmenu", prewarmTranslatorFromGesture, true);
  }

  // 右クリック前に言語だけ解決しておくと、user gesture中にTranslator.create()を即開始できる。
  void resolveSourceLanguage().catch(() => undefined);
  void maybeStartAutoTranslate().catch(notifyError);
}
