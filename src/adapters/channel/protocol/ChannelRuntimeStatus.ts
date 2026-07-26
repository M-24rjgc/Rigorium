import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GatewayChannelKey } from "../../../gateway/index.js";

export type ChannelRuntimeState =
  | "starting"
  | "connected"
  | "waiting_for_login"
  | "expired"
  | "failed"
  | "stopped";

export type ChannelRuntimeStatus = {
  channelKey: GatewayChannelKey;
  state: ChannelRuntimeState;
  updatedAt: string;
  message?: string;
  accountId?: string;
  error?: string;
  qrUrl?: string;
};

export type ChannelRuntimeStatusUpdate = {
  state: ChannelRuntimeState;
  message?: string;
  accountId?: string;
  error?: string;
  qrUrl?: string;
};

export type ChannelRuntimeStatusSnapshot = {
  updatedAt: string;
  channels: Record<string, ChannelRuntimeStatus>;
};

export type ChannelRuntimeStatusReporter = (
  channelKey: GatewayChannelKey,
  update: ChannelRuntimeStatusUpdate,
) => void;

export function channelRuntimeStatusPath(rigoriumHome: string): string {
  return join(rigoriumHome, "channels", "runtime-status.json");
}

export function readChannelRuntimeStatusSnapshot(rigoriumHome: string): ChannelRuntimeStatusSnapshot {
  const path = channelRuntimeStatusPath(rigoriumHome);
  if (!existsSync(path)) {
    return { updatedAt: new Date(0).toISOString(), channels: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChannelRuntimeStatusSnapshot>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      channels: parsed.channels && typeof parsed.channels === "object" ? parsed.channels : {},
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), channels: {} };
  }
}

export function createChannelRuntimeStatusReporter(rigoriumHome: string): ChannelRuntimeStatusReporter {
  const path = channelRuntimeStatusPath(rigoriumHome);

  return (channelKey, update) => {
    const now = new Date().toISOString();
    const snapshot = readChannelRuntimeStatusSnapshot(rigoriumHome);
    const next: ChannelRuntimeStatusSnapshot = {
      updatedAt: now,
      channels: {
        ...snapshot.channels,
        [channelKey]: {
          channelKey,
          state: update.state,
          updatedAt: now,
          ...(update.message ? { message: update.message } : {}),
          ...(update.accountId ? { accountId: update.accountId } : {}),
          ...(update.error ? { error: update.error } : {}),
          ...(update.qrUrl ? { qrUrl: update.qrUrl } : {}),
        },
      },
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  };
}
