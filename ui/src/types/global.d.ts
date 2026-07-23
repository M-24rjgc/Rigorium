export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    refreshProjects?: () => void | Promise<void>;
    openSettings?: (tab?: string) => void;
    rigoriumZoteroCredentials?: {
      status: () => Promise<{ encryptionAvailable: boolean; configured: boolean }>;
      save: (apiKey: string) => Promise<{ encryptionAvailable: boolean; configured: boolean }>;
      clear: (options: { confirmed: boolean }) => Promise<{ encryptionAvailable: boolean; configured: boolean }>;
    };
    rigoriumZoteroCloud?: {
      status: (options?: { projectPath?: string }) => Promise<unknown>;
      sync: (options?: { projectPath?: string; sinceVersion?: number }) => Promise<unknown>;
      preview: (intent: unknown, options?: { projectPath?: string }) => Promise<unknown>;
      confirm: (plan: unknown, options?: { projectPath?: string }) => Promise<unknown>;
    };
    rigoriumZoteroLibrary?: {
      importPapers: (papers: unknown[], options?: { projectPath?: string }) => Promise<unknown>;
      openAttachment: (attachmentKey: string, options?: { projectPath?: string }) => Promise<{ opened: boolean }>;
    };
    // Returns true if a project matching the given name was found and the
    // app navigated to it; false otherwise so callers (e.g. chat slash
    // command handler) can surface a friendly "not found" message.
    switchProject?: (projectName: string) => boolean;
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
