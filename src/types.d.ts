type AiAvailability = "unavailable" | "downloadable" | "downloading" | "available";

type DownloadProgressEvent = Event & { loaded: number };

type AiMonitor = {
  addEventListener(
    type: "downloadprogress",
    listener: (event: DownloadProgressEvent) => void,
  ): void;
};

type TranslatorInstance = {
  translate(input: string): Promise<string>;
  destroy?(): void;
};

type TranslatorFactory = {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<AiAvailability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: AiMonitor) => void;
  }): Promise<TranslatorInstance>;
};

declare const Translator: TranslatorFactory;

declare namespace chrome {
  namespace runtime {
    type MessageSender = {
      tab?: tabs.Tab;
      frameId?: number;
      url?: string;
    };

    const onInstalled: { addListener(callback: () => void): void };
    const onStartup: { addListener(callback: () => void): void };
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };

    function sendMessage<T = unknown>(message: unknown): Promise<T>;
  }

  namespace i18n {
    type LanguageDetectionResult = {
      isReliable: boolean;
      languages: Array<{ language: string; percentage: number }>;
    };
    function detectLanguage(text: string): Promise<LanguageDetectionResult>;
  }

  namespace contextMenus {
    type OnClickData = {
      menuItemId: string | number;
      pageUrl?: string;
      frameUrl?: string;
      frameId?: number;
    };
    function removeAll(): Promise<void>;
    function create(properties: {
      id: string;
      title?: string;
      type?: "normal" | "separator";
      contexts?: Array<"all" | "page" | "frame" | "selection" | "link" | "editable" | "image" | "video" | "audio">;
    }): string | number;
    const onClicked: {
      addListener(callback: (info: OnClickData, tab?: tabs.Tab) => void): void;
    };
  }

  namespace tabs {
    type Tab = { id?: number; url?: string; title?: string };
    type TabChangeInfo = { url?: string; status?: string };
    function sendMessage<T = unknown>(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<T>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
  }

  namespace storage {
    namespace local {
      function get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
    }
    type StorageChange = { oldValue?: unknown; newValue?: unknown };
    const onChanged: {
      addListener(
        callback: (changes: Record<string, StorageChange>, areaName: string) => void,
      ): void;
    };
  }

  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setTitle(details: { tabId?: number; title: string }): Promise<void>;
  }

  namespace commands {
    const onCommand: {
      addListener(callback: (command: string, tab?: tabs.Tab) => void): void;
    };
  }
}
