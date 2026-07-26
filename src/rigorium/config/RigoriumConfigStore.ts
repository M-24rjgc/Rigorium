import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getRigoriumConfigFilePath, resolveRigoriumHome } from "../paths.js";
import { classifyConfigChanges, diffConfigSnapshots } from "./classifyChanges.js";
import { loadRigoriumConfig } from "./loadRigoriumConfig.js";
import {
  RigoriumConfigError,
  type RigoriumConfigDiagnostic,
  type RigoriumConfigLoadOptions,
  type RigoriumConfigReloadEvent,
  type RigoriumConfigSnapshot,
} from "./types.js";

export type RigoriumConfigListener = (event: RigoriumConfigReloadEvent) => void;

export type RigoriumConfigStore = {
  getSnapshot(): RigoriumConfigSnapshot;
  getDiagnostics(): RigoriumConfigDiagnostic[];
  reload(reason?: string): Promise<RigoriumConfigSnapshot>;
  subscribe(listener: RigoriumConfigListener): () => void;
  startWatching(options?: { debounceMs?: number }): () => void;
};

export async function createRigoriumConfigStore(
  options: RigoriumConfigLoadOptions = {},
): Promise<RigoriumConfigStore> {
  return createRigoriumConfigStoreSync(options);
}

export function createRigoriumConfigStoreSync(
  options: RigoriumConfigLoadOptions = {},
): RigoriumConfigStore {
  const initialSnapshot = loadRigoriumConfig(options);
  return new DefaultRigoriumConfigStore(initialSnapshot, options);
}

class DefaultRigoriumConfigStore implements RigoriumConfigStore {
  private currentSnapshot: RigoriumConfigSnapshot;
  private lastReloadDiagnostics: RigoriumConfigDiagnostic[] = [];
  private readonly listeners = new Set<RigoriumConfigListener>();
  private reloading: Promise<RigoriumConfigSnapshot> | undefined;
  private nextVersion: number;

  constructor(
    initialSnapshot: RigoriumConfigSnapshot,
    private readonly options: RigoriumConfigLoadOptions,
  ) {
    this.currentSnapshot = initialSnapshot;
    this.nextVersion = initialSnapshot.version + 1;
  }

  getSnapshot(): RigoriumConfigSnapshot {
    return this.currentSnapshot;
  }

  getDiagnostics(): RigoriumConfigDiagnostic[] {
    return [...this.currentSnapshot.diagnostics, ...this.lastReloadDiagnostics];
  }

  async reload(_reason = "manual"): Promise<RigoriumConfigSnapshot> {
    if (this.reloading) {
      return this.reloading;
    }

    this.reloading = Promise.resolve()
      .then(() => {
        const previousSnapshot = this.currentSnapshot;
        const nextSnapshot = loadRigoriumConfig({
          ...this.options,
          version: this.nextVersion,
        });
        const changedPaths = diffConfigSnapshots(previousSnapshot, nextSnapshot);
        const changeClasses = classifyConfigChanges(changedPaths);

        this.currentSnapshot = nextSnapshot;
        this.nextVersion = nextSnapshot.version + 1;
        this.lastReloadDiagnostics = [];
        this.publish({
          previousSnapshot,
          nextSnapshot,
          changedPaths,
          changeClasses,
        });

        return nextSnapshot;
      })
      .catch((error: unknown) => {
        if (error instanceof RigoriumConfigError) {
          this.lastReloadDiagnostics = error.diagnostics;
        }
        throw error;
      })
      .finally(() => {
        this.reloading = undefined;
      });

    return this.reloading;
  }

  subscribe(listener: RigoriumConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startWatching(options: { debounceMs?: number } = {}): () => void {
    const debounceMs = options.debounceMs ?? 250;
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;

    const scheduleReload = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void this.reload("watch").catch(() => {
          // Reload diagnostics are retained on the store; watchers must not crash the runtime.
        });
      }, debounceMs);
    };

    for (const path of this.getWatchedPaths()) {
      const watchedPath = existsSync(path) ? path : dirname(path);
      try {
        watchers.push(watch(watchedPath, scheduleReload));
      } catch {
        // Watcher support is best effort. Manual reload remains available.
      }
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    };
  }

  private publish(event: RigoriumConfigReloadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers cannot block or break snapshot publication.
      }
    }
  }

  private getWatchedPaths(): string[] {
    const env = this.options.env ?? process.env;
    const rigoriumHome = resolveRigoriumHome(env);
    return [getRigoriumConfigFilePath(rigoriumHome)];
  }
}
