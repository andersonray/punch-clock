// Typed wrappers around the punch_clock/* WebSocket commands (see docs/websocket-api.md).

import type {
  Block,
  BlockInput,
  BlockUpdate,
  Config,
  ExplainNode,
  Group,
  HomeAssistant,
  Info,
  Settings,
  Status,
  Tab,
} from "./types";

export type PushEvent = { kind: "config"; config: Config } | { kind: "status"; status: Status };

export class PunchClockApi {
  constructor(private readonly hassRef: () => HomeAssistant) {}

  private call<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.hassRef().callWS<T>({ type: `punch_clock/${type}`, ...payload });
  }

  info(): Promise<Info> {
    return this.call("info");
  }

  /** Streams config and status snapshots; resubscribes automatically after reconnects. */
  subscribe(callback: (event: PushEvent) => void): Promise<() => Promise<void>> {
    return this.hassRef().connection.subscribeMessage<PushEvent>(callback, {
      type: "punch_clock/subscribe",
    });
  }

  updateSettings(changes: Partial<Settings>): Promise<{ settings: Settings }> {
    return this.call("settings/update", { changes });
  }

  createTab(tab: Partial<Omit<Tab, "id">> & { name: string }): Promise<{ tab: Tab }> {
    return this.call("tabs/create", { tab });
  }

  updateTab(tabId: string, changes: Partial<Omit<Tab, "id">>): Promise<{ tab: Tab }> {
    return this.call("tabs/update", { tab_id: tabId, changes });
  }

  deleteTab(tabId: string): Promise<void> {
    return this.call("tabs/delete", { tab_id: tabId });
  }

  /** Copy a tab and its blocks into a new tab, turned off, right after it. */
  duplicateTab(tabId: string): Promise<{ tab: Tab; blocks: Block[] }> {
    return this.call("tabs/duplicate", { tab_id: tabId });
  }

  reorderTabs(order: string[]): Promise<void> {
    return this.call("tabs/reorder", { order });
  }

  createBlocks(blocks: BlockInput[]): Promise<{ blocks: Block[] }> {
    return this.call("blocks/create", { blocks });
  }

  updateBlock(blockId: string, changes: Partial<BlockInput>): Promise<{ block: Block }> {
    return this.call("blocks/update", { block_id: blockId, changes });
  }

  /** Updates several blocks at once (all or nothing), such as every block of a group. */
  updateBlocks(updates: BlockUpdate[]): Promise<{ blocks: Block[] }> {
    return this.call("blocks/update_many", { updates });
  }

  deleteBlock(blockId: string): Promise<void> {
    return this.call("blocks/delete", { block_id: blockId });
  }

  deleteBlocks(blockIds: string[]): Promise<void> {
    return this.call("blocks/delete_many", { block_ids: blockIds });
  }

  evaluate(conditions: Group): Promise<ExplainNode> {
    return this.call("conditions/evaluate", { conditions });
  }

  reapply(): Promise<void> {
    return this.call("reapply");
  }
}

/** Best-effort readable message from a failed WebSocket call. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}
