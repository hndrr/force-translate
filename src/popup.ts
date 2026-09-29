namespace ForceTranslatePopup {
  const TARGET_LANGUAGE = "ja";
  const STORAGE_AUTO_ORIGINS = "autoTranslateOrigins";

  type PageStatus = {
    ok: true;
    active: boolean;
    sourceLanguage: string | null;
    origin: string | null;
  };

  const siteLabel = document.querySelector<HTMLDivElement>("#siteLabel")!;
  const stateBadge = document.querySelector<HTMLSpanElement>("#stateBadge")!;
  const translateButton = document.querySelector<HTMLButtonElement>("#translateButton")!;
  const restoreButton = document.querySelector<HTMLButtonElement>("#restoreButton")!;
  const autoToggle = document.querySelector<HTMLInputElement>("#autoToggle")!;
  const progressWrap = document.querySelector<HTMLDivElement>("#progressWrap")!;
  const progressBar = document.querySelector<HTMLDivElement>("#progressBar")!;
  const progressText = document.querySelector<HTMLDivElement>("#progressText")!;
  const message = document.querySelector<HTMLDivElement>("#message")!;

  let activeTab: chrome.tabs.Tab | null = null;
  let pageStatus: PageStatus | null = null;
  let busy = false;

  function getOrigin(url: string | undefined): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  function setMessage(text: string, isError = false): void {
    message.textContent = text;
    message.classList.toggle("error", isError);
  }

  function setBusy(next: boolean): void {
    busy = next;
    translateButton.disabled = next || !activeTab?.id || !pageStatus?.sourceLanguage;
    restoreButton.disabled = next || !activeTab?.id || !pageStatus?.active;
    autoToggle.disabled = next || !activeTab?.id || !pageStatus?.origin;
  }

  function renderStatus(status: PageStatus): void {
    pageStatus = status;
    stateBadge.textContent = status.active ? "翻訳中" : "待機";
    stateBadge.classList.toggle("active", status.active);
    translateButton.textContent = status.active ? "翻訳を更新" : "このページを翻訳";
    restoreButton.disabled = busy || !status.active;
  }

  async function getAutoOrigins(): Promise<string[]> {
    const stored = await chrome.storage.local.get(STORAGE_AUTO_ORIGINS);
    const value = stored[STORAGE_AUTO_ORIGINS];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  async function setAutoEnabled(origin: string, enabled: boolean): Promise<void> {
    const next = new Set(await getAutoOrigins());
    if (enabled) next.add(origin);
    else next.delete(origin);
    await chrome.storage.local.set({ [STORAGE_AUTO_ORIGINS]: [...next] });
  }

  async function fetchPageStatus(): Promise<PageStatus> {
    if (!activeTab?.id) throw new Error("現在のタブを取得できません");
    return chrome.tabs.sendMessage<PageStatus>(
      activeTab.id,
      { type: "FT_GET_STATUS" },
      { frameId: 0 },
    );
  }

  async function prepareTranslatorFromUserClick(sourceLanguage: string): Promise<void> {
    if (!("Translator" in globalThis)) {
      throw new Error("このChromeではTranslator APIを利用できません");
    }
    if (sourceLanguage === TARGET_LANGUAGE) return;

    progressWrap.hidden = false;
    progressBar.style.width = "0%";
    progressText.textContent = `${sourceLanguage} → ja の翻訳モデルを準備中…`;

    // この関数はbutton/changeイベントの同期ハンドラから、最初のawaitより前に呼ぶ。
    // モデル未取得時のuser activationをpopup側で確保する。
    const translatorPromise = Translator.create({
      sourceLanguage,
      targetLanguage: TARGET_LANGUAGE,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const percent = Math.max(0, Math.min(100, Math.round(event.loaded * 100)));
          progressBar.style.width = `${percent}%`;
          progressText.textContent = `翻訳モデルを準備中… ${percent}%`;
        });
      },
    });

    const translator = await translatorPromise;
    progressBar.style.width = "100%";
    progressText.textContent = "翻訳モデルの準備完了";
    translator.destroy?.();
  }

  async function startTranslation(): Promise<void> {
    if (!activeTab?.id || !pageStatus?.sourceLanguage) return;
    setBusy(true);
    setMessage("");
    try {
      const preparation = prepareTranslatorFromUserClick(pageStatus.sourceLanguage);
      await preparation;
      await chrome.tabs.sendMessage(activeTab.id, { type: "FT_START_TRANSLATION" });
      renderStatus(await fetchPageStatus());
      setMessage("翻訳を開始しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function restoreOriginal(): Promise<void> {
    if (!activeTab?.id) return;
    setBusy(true);
    setMessage("");
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: "FT_RESTORE_ORIGINAL" });
      renderStatus(await fetchPageStatus());
      setMessage("原文に戻しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function changeAutoTranslate(): Promise<void> {
    if (!activeTab?.id || !pageStatus?.origin || !pageStatus.sourceLanguage) return;
    const enabled = autoToggle.checked;
    setBusy(true);
    setMessage("");
    try {
      if (enabled) {
        const preparation = prepareTranslatorFromUserClick(pageStatus.sourceLanguage);
        await preparation;
        await setAutoEnabled(pageStatus.origin, true);
        await chrome.tabs.sendMessage(activeTab.id, { type: "FT_START_TRANSLATION" });
        setMessage("このサイトの自動翻訳をONにしました");
      } else {
        await setAutoEnabled(pageStatus.origin, false);
        await chrome.tabs.sendMessage(activeTab.id, { type: "FT_RESTORE_ORIGINAL" });
        progressWrap.hidden = true;
        setMessage("このサイトの自動翻訳をOFFにしました");
      }
      renderStatus(await fetchPageStatus());
    } catch (error) {
      autoToggle.checked = !enabled;
      setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function init(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab ?? null;
    const origin = getOrigin(tab?.url);
    siteLabel.textContent = origin ? new URL(origin).hostname : "このページでは利用できません";

    if (!tab?.id || !origin) {
      translateButton.disabled = true;
      restoreButton.disabled = true;
      autoToggle.disabled = true;
      setMessage("通常のWebページで使用してください", true);
      return;
    }

    try {
      const status = await fetchPageStatus();
      renderStatus(status);
      autoToggle.checked = (await getAutoOrigins()).includes(origin);
      setBusy(false);
    } catch {
      translateButton.disabled = true;
      restoreButton.disabled = true;
      autoToggle.disabled = true;
      setMessage("このタブを一度再読み込みしてください", true);
    }
  }

  translateButton.addEventListener("click", () => void startTranslation());
  restoreButton.addEventListener("click", () => void restoreOriginal());
  autoToggle.addEventListener("change", () => void changeAutoTranslate());

  setBusy(true);
  void init();
}
