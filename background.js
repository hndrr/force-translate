"use strict";
var ForceTranslateBackground;
(function (ForceTranslateBackground) {
    const MENU_TRANSLATE = "force-translate-page";
    const MENU_RESTORE = "force-translate-restore";
    const MENU_AUTO = "force-translate-auto-site";
    const STORAGE_AUTO_ORIGINS = "autoTranslateOrigins";
    function isRecord(value) {
        return typeof value === "object" && value !== null;
    }
    function isRuntimeMessage(value) {
        return isRecord(value) &&
            (value.type === "FT_PROXY_TRANSLATE_BATCH" || value.type === "FT_REQUEST_BROADCAST_START");
    }
    async function setupMenus() {
        await chrome.contextMenus.removeAll();
        chrome.contextMenus.create({ id: MENU_TRANSLATE, title: "このページを強制翻訳", contexts: ["all"] });
        chrome.contextMenus.create({ id: MENU_RESTORE, title: "原文に戻す", contexts: ["all"] });
        chrome.contextMenus.create({ id: "force-translate-separator", type: "separator", contexts: ["all"] });
        chrome.contextMenus.create({ id: MENU_AUTO, title: "このサイトの自動翻訳を切り替え", contexts: ["all"] });
    }
    async function broadcastToTab(tabId, message) {
        try {
            await chrome.tabs.sendMessage(tabId, message);
        }
        catch {
            // Chrome内部ページなどcontent scriptを注入できないページは対象外。
        }
    }
    function getOrigin(url) {
        if (!url)
            return null;
        try {
            const parsed = new URL(url);
            return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
        }
        catch {
            return null;
        }
    }
    async function getAutoOrigins() {
        const stored = await chrome.storage.local.get(STORAGE_AUTO_ORIGINS);
        const value = stored[STORAGE_AUTO_ORIGINS];
        return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    }
    async function isAutoEnabled(url) {
        const origin = getOrigin(url);
        if (!origin)
            return false;
        return (await getAutoOrigins()).includes(origin);
    }
    async function updateActionBadge(tab) {
        if (tab.id === undefined)
            return;
        const enabled = await isAutoEnabled(tab.url);
        await chrome.action.setBadgeText({ tabId: tab.id, text: enabled ? "A" : "" });
        await chrome.action.setTitle({
            tabId: tab.id,
            title: enabled ? "Force Translate — このサイトは自動翻訳ON" : "Force Translate",
        });
    }
    async function refreshAllBadges() {
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.map((tab) => updateActionBadge(tab)));
    }
    async function toggleAutoTranslate(tab) {
        if (tab.id === undefined)
            return;
        const origin = getOrigin(tab.url);
        if (!origin)
            return;
        const next = new Set(await getAutoOrigins());
        const enabled = !next.has(origin);
        if (enabled)
            next.add(origin);
        else
            next.delete(origin);
        await chrome.storage.local.set({ [STORAGE_AUTO_ORIGINS]: [...next] });
        if (enabled) {
            await broadcastToTab(tab.id, { type: "FT_START_TRANSLATION" });
        }
        await updateActionBadge(tab);
    }
    async function toggleCurrentTabTranslation() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id)
            return;
        try {
            const status = await chrome.tabs.sendMessage(tab.id, { type: "FT_GET_STATUS" }, { frameId: 0 });
            await broadcastToTab(tab.id, {
                type: status.active ? "FT_RESTORE_ORIGINAL" : "FT_START_TRANSLATION",
            });
        }
        catch {
            // 対象外ページでは何もしない。
        }
    }
    chrome.runtime.onInstalled.addListener(() => {
        void setupMenus();
        void refreshAllBadges();
    });
    chrome.runtime.onStartup.addListener(() => {
        void setupMenus();
        void refreshAllBadges();
    });
    chrome.contextMenus.onClicked.addListener((info, tab) => {
        if (!tab || tab.id === undefined)
            return;
        if (info.menuItemId === MENU_TRANSLATE) {
            void broadcastToTab(tab.id, { type: "FT_START_TRANSLATION" });
        }
        else if (info.menuItemId === MENU_RESTORE) {
            void broadcastToTab(tab.id, { type: "FT_RESTORE_ORIGINAL" });
        }
        else if (info.menuItemId === MENU_AUTO) {
            void toggleAutoTranslate(tab);
        }
    });
    chrome.commands.onCommand.addListener((command) => {
        if (command === "toggle-translation")
            void toggleCurrentTabTranslation();
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => {
        void chrome.tabs.get(tabId).then(updateActionBadge).catch(() => undefined);
    });
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.url || changeInfo.status === "complete")
            void updateActionBadge(tab);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && STORAGE_AUTO_ORIGINS in changes)
            void refreshAllBadges();
    });
    chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
        if (!isRuntimeMessage(rawMessage))
            return;
        const tabId = sender.tab?.id;
        if (tabId === undefined)
            return;
        if (rawMessage.type === "FT_REQUEST_BROADCAST_START") {
            void broadcastToTab(tabId, { type: "FT_START_TRANSLATION" });
            return;
        }
        void chrome.tabs
            .sendMessage(tabId, {
            type: "FT_TRANSLATE_PROXY_BATCH",
            sourceLanguage: rawMessage.sourceLanguage,
            texts: rawMessage.texts,
        }, { frameId: 0 })
            .then(sendResponse)
            .catch((error) => {
            sendResponse({
                ok: false,
                code: "proxy-error",
                message: error instanceof Error ? error.message : String(error),
            });
        });
        return true;
    });
})(ForceTranslateBackground || (ForceTranslateBackground = {}));
