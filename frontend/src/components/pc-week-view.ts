import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { Block, Config, HomeAssistant, Status } from "../types";
import {
  MINUTES_PER_DAY,
  SNAP_MINUTES,
  clamp,
  dayName,
  displayDays,
  formatHour,
  formatMinute,
  formatRange,
  nowIn,
  segments,
  snapCeil,
  snapFloor,
  type Segment,
  type WallClock,
} from "../logic/time";
import { layoutDay, type Placed } from "../logic/layout";
import { blockLabel, countConditions, findConflicts, type Conflict } from "../logic/model";
import { controls } from "../styles";
import { icon, mdiAlertOutline, mdiFilterVariant } from "../icons";

export interface CreateBlockDetail {
  day: number;
  start: number;
  duration: number;
}

interface Ghost {
  day: number;
  start: number;
  end: number;
}

interface Drag {
  day: number;
  col: HTMLElement;
  anchor: number;
  startY: number;
  lastY: number;
  moved: boolean;
  touch: boolean;
}

interface Press {
  day: number;
  col: HTMLElement;
  x: number;
  y: number;
  timer: number;
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 8;
const EDGE_SCROLL_PX = 48;
const MIN_BLOCK_PX = 18;

/**
 * The week calendar for one tab. Days are columns, time runs down. Blocks that
 * overlap in time share the column width; a strip on the right of every column
 * stays free so new blocks can always be dragged out.
 *
 * Events: `create-block` (CreateBlockDetail), `select-block` / `pick-block`
 * ({ blockId }), `background-click`.
 */
export class PcWeekView extends LitElement {
  static override properties = {
    hass: { attribute: false },
    config: { attribute: false },
    tabId: {},
    status: { attribute: false },
    selectedId: {},
    picking: { type: Boolean },
    use24h: { type: Boolean },
    language: {},
    timeZone: {},
    hourHeight: { type: Number },
    initialHour: { type: Number },
    _ghost: { state: true },
    _now: { state: true },
  };

  declare hass: HomeAssistant;
  declare config: Config;
  declare tabId: string;
  declare status: Status | null;
  declare selectedId: string | null;
  /** Eyedropper mode: clicking a block picks it instead of selecting it. */
  declare picking: boolean;
  declare use24h: boolean;
  declare language: string;
  declare timeZone: string;
  declare hourHeight: number;
  /** Hour to scroll to initially; negative means "an hour before now". */
  declare initialHour: number;
  declare _ghost: Ghost | null;
  declare _now: WallClock;

  private drag: Drag | null = null;
  private press: Press | null = null;
  private scrollFrame = 0;
  private nowTimer = 0;
  private scrolledInitially = false;
  private suppressClickUntil = 0;

  constructor() {
    super();
    this.status = null;
    this.selectedId = null;
    this.picking = false;
    this.use24h = false;
    this.language = "en";
    this.timeZone = "UTC";
    this.hourHeight = 48;
    this.initialHour = -1;
    this._ghost = null;
    this._now = { day: -1, minute: 0 };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._now = nowIn(this.timeZone);
    this.nowTimer = window.setInterval(() => (this._now = nowIn(this.timeZone)), 30_000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.nowTimer);
    this.cancelDrag();
  }

  /** `hass` changes many times a second; the calendar only needs it for labels. */
  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    return !(changed.size === 1 && changed.has("hass"));
  }

  protected override firstUpdated(): void {
    this.scroller.addEventListener("touchmove", this.onTouchMove, { passive: false });
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("timeZone")) this._now = nowIn(this.timeZone);
    if (!this.scrolledInitially && this.config) {
      this.scrolledInitially = true;
      const hour =
        this.initialHour >= 0 ? this.initialHour : Math.max(0, this._now.minute / 60 - 1);
      this.scroller.scrollTop = hour * this.hourHeight;
    }
  }

  private get scroller(): HTMLElement {
    return this.renderRoot.querySelector(".scroller") as HTMLElement;
  }

  // --- Drag to create ------------------------------------------------------

  private minuteAt(col: HTMLElement, clientY: number): number {
    const rect = col.getBoundingClientRect();
    return clamp(((clientY - rect.top) / this.hourHeight) * 60, 0, MINUTES_PER_DAY);
  }

  private beginDrag(day: number, col: HTMLElement, clientY: number, touch: boolean): void {
    const anchor = Math.min(snapFloor(this.minuteAt(col, clientY)), MINUTES_PER_DAY - SNAP_MINUTES);
    this.drag = { day, col, anchor, startY: clientY, lastY: clientY, moved: touch, touch };
    this._ghost = { day, start: anchor, end: anchor + SNAP_MINUTES };
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  }

  private updateDrag(clientY: number): void {
    const drag = this.drag;
    if (!drag) return;
    drag.lastY = clientY;
    if (Math.abs(clientY - drag.startY) > MOVE_TOLERANCE_PX) drag.moved = true;
    const minute = this.minuteAt(drag.col, clientY);
    let start: number;
    let end: number;
    if (minute >= drag.anchor) {
      start = drag.anchor;
      end = Math.max(drag.anchor + SNAP_MINUTES, snapCeil(minute));
    } else {
      start = snapFloor(minute);
      end = drag.anchor + SNAP_MINUTES;
    }
    this._ghost = {
      day: drag.day,
      start: clamp(start, 0, MINUTES_PER_DAY - SNAP_MINUTES),
      end: clamp(end, SNAP_MINUTES, MINUTES_PER_DAY),
    };
  }

  private finishDrag(): void {
    const drag = this.drag;
    const ghost = this._ghost;
    this.cancelDrag();
    if (!drag || !ghost) return;
    if (!drag.moved) {
      this.fire("background-click");
      return;
    }
    this.suppressClickUntil = performance.now() + 400;
    this.fire<CreateBlockDetail>("create-block", {
      day: ghost.day,
      start: ghost.start,
      duration: ghost.end - ghost.start,
    });
  }

  private cancelDrag(): void {
    cancelAnimationFrame(this.scrollFrame);
    if (this.press) window.clearTimeout(this.press.timer);
    this.press = null;
    this.drag = null;
    this._ghost = null;
  }

  private readonly autoScroll = (): void => {
    const drag = this.drag;
    if (!drag) return;
    const rect = this.scroller.getBoundingClientRect();
    const head =
      (this.renderRoot.querySelector(".day-head") as HTMLElement | null)?.offsetHeight ?? 0;
    let delta = 0;
    if (drag.lastY < rect.top + head + EDGE_SCROLL_PX) delta = -12;
    else if (drag.lastY > rect.bottom - EDGE_SCROLL_PX) delta = 12;
    if (delta) {
      this.scroller.scrollTop += delta;
      this.updateDrag(drag.lastY);
    }
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  };

  private onPointerDown(e: PointerEvent, day: number): void {
    if (e.pointerType === "touch" || e.button !== 0 || this.picking) return;
    if ((e.target as HTMLElement).closest(".block")) return;
    const col = e.currentTarget as HTMLElement;
    e.preventDefault();
    col.setPointerCapture?.(e.pointerId);
    this.beginDrag(day, col, e.clientY, false);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag && !this.drag.touch) this.updateDrag(e.clientY);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && !this.drag.touch) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      this.finishDrag();
    }
  }

  private onTouchStart(e: TouchEvent, day: number): void {
    if (this.picking || e.touches.length !== 1) return;
    if ((e.target as HTMLElement).closest(".block")) return;
    const touch = e.touches[0]!;
    const col = e.currentTarget as HTMLElement;
    const timer = window.setTimeout(() => {
      this.press = null;
      navigator.vibrate?.(15);
      this.beginDrag(day, col, touch.clientY, true);
    }, LONG_PRESS_MS);
    this.press = { day, col, x: touch.clientX, y: touch.clientY, timer };
  }

  private readonly onTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    if (this.press) {
      if (
        Math.hypot(touch.clientX - this.press.x, touch.clientY - this.press.y) > MOVE_TOLERANCE_PX
      ) {
        window.clearTimeout(this.press.timer);
        this.press = null; // it's a scroll
      }
      return;
    }
    if (this.drag?.touch) {
      e.preventDefault(); // keep the page from scrolling while dragging
      this.updateDrag(touch.clientY);
    }
  };

  private onTouchEnd(e: TouchEvent): void {
    if (this.press) {
      window.clearTimeout(this.press.timer);
      this.press = null;
      this.fire("background-click");
      return;
    }
    if (this.drag?.touch) {
      e.preventDefault();
      this.finishDrag();
    }
  }

  // --- Rendering -----------------------------------------------------------

  private fire<T>(type: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private onBlockClick(e: Event, block: Block): void {
    e.stopPropagation();
    if (performance.now() < this.suppressClickUntil) return;
    this.fire(this.picking ? "pick-block" : "select-block", { blockId: block.id });
  }

  private renderBlock(
    block: Block,
    seg: Segment,
    placed: Placed,
    conflicts: Conflict[] | undefined,
    missing: boolean,
  ): TemplateResult {
    const hour = this.hourHeight;
    const top = (seg.start / 60) * hour;
    const height = Math.max(((seg.end - seg.start) / 60) * hour, MIN_BLOCK_PX);
    const state = this.status?.blocks[block.id];
    const classes = [
      "block",
      block.id === this.selectedId ? "selected" : "",
      state?.active ? "active" : "",
      state && state.in_window && !state.active ? "waiting" : "",
      height < 36 ? "compact" : "",
      seg.continuation ? "continuation" : "",
      seg.continues ? "continues" : "",
    ].join(" ");
    const label = blockLabel(block, this.hass?.states);
    const range = formatRange(block.start, block.duration, this.use24h);
    const conditionCount = countConditions(block.conditions);
    const day = dayName(block.day, this.language, "long");
    const notes = [
      state?.active ? "active now" : state?.in_window ? "waiting: conditions are false" : "",
      conflicts?.length ? "conflicts with another block" : "",
      missing ? "uses an entity that doesn't exist" : "",
    ].filter(Boolean);
    return html`<button
      class=${classes}
      style="top:${top}px;height:${height}px;--left:${placed.left};--width:${placed.width};--block-color:${block.color}"
      aria-label=${`${label}, ${day} ${range}${notes.length ? `, ${notes.join(", ")}` : ""}`}
      title=${`${label}\n${day} ${range}${notes.length ? `\n${notes.join("\n")}` : ""}`}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @touchstart=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => this.onBlockClick(e, block)}
    >
      <span class="name">${label}</span>
      <span class="time">${range}</span>
      <span class="badges">
        ${conditionCount ? html`<span title="Has conditions">${icon(mdiFilterVariant, 14)}</span>` : nothing}
        ${
          conflicts?.length || missing
            ? html`<span class="warn" title=${notes.join(", ")}>${icon(mdiAlertOutline, 14)}</span>`
            : nothing
        }
      </span>
    </button>`;
  }

  private renderColumn(
    day: number,
    items: { block: Block; seg: Segment }[],
    conflicts: Map<string, Conflict[]>,
  ): TemplateResult {
    const minVisual = (MIN_BLOCK_PX / this.hourHeight) * 60;
    const placed = layoutDay(
      items.map(({ block, seg }) => ({
        id: `${block.id}:${seg.continuation ? 1 : 0}`,
        start: seg.start,
        end: seg.end,
        seq: block.seq,
      })),
      minVisual,
    );
    const byId = new Map(placed.map((p) => [p.id, p]));
    const states = this.hass?.states ?? {};
    const ghost = this._ghost?.day === day ? this._ghost : null;
    const today = this._now.day === day;
    return html`<div
      class="col ${today ? "today" : ""}"
      @pointerdown=${(e: PointerEvent) => this.onPointerDown(e, day)}
      @pointermove=${this.onPointerMove}
      @pointerup=${this.onPointerUp}
      @pointercancel=${() => this.cancelDrag()}
      @touchstart=${{ handleEvent: (e: TouchEvent) => this.onTouchStart(e, day), passive: true }}
      @touchend=${(e: TouchEvent) => this.onTouchEnd(e)}
      @touchcancel=${() => this.cancelDrag()}
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      ${items.map(({ block, seg }) => {
        const p = byId.get(`${block.id}:${seg.continuation ? 1 : 0}`)!;
        const missing = block.actions.some(
          (a) => a.type === "entity" && a.entity_id && !states[a.entity_id],
        );
        return this.renderBlock(block, seg, p, conflicts.get(block.id), missing);
      })}
      ${
        ghost
          ? html`<div
              class="ghost"
              style="top:${(ghost.start / 60) * this.hourHeight}px;height:${((ghost.end - ghost.start) / 60) * this.hourHeight}px"
            >
              ${formatMinute(ghost.start, this.use24h)} – ${formatMinute(ghost.end, this.use24h)}
            </div>`
          : nothing
      }
      ${
        today
          ? html`<div class="now" style="top:${(this._now.minute / 60) * this.hourHeight}px"></div>`
          : nothing
      }
    </div>`;
  }

  protected override render() {
    if (!this.config) return nothing;
    const days = displayDays(this.config.settings.week_start);
    const blocks = this.config.blocks.filter((b) => b.tab_id === this.tabId);
    const conflicts = findConflicts(blocks);
    const byDay = new Map<number, { block: Block; seg: Segment }[]>();
    for (const block of blocks) {
      for (const seg of segments(block.day, block.start, block.duration)) {
        const list = byDay.get(seg.day) ?? [];
        list.push({ block, seg });
        byDay.set(seg.day, list);
      }
    }
    return html`<div
      class="scroller ${this.picking ? "picking" : ""}"
      style="--hour:${this.hourHeight}px"
    >
      <div class="grid" role="grid" aria-label="Week schedule">
        <div class="corner"></div>
        ${days.map(
          (d) =>
            html`<div class="day-head ${d === this._now.day ? "today" : ""}" role="columnheader">
              <span class="dname">${dayName(d, this.language, "short")}</span>
            </div>`,
        )}
        <div class="gutter" aria-hidden="true">
          ${Array.from({ length: 23 }, (_, i) => i + 1).map(
            (h) =>
              html`<span style="top:${h * this.hourHeight}px">${formatHour(h, this.use24h)}</span>`,
          )}
        </div>
        ${days.map((d) => this.renderColumn(d, byDay.get(d) ?? [], conflicts))}
      </div>
    </div>`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        min-height: 0;
        --gutter: 52px;
        --min-col: 108px;
        --strip: max(22px, 14%);
      }
      .scroller {
        height: 100%;
        overflow: auto;
        overscroll-behavior: contain;
        background: var(--pc-card);
      }
      .grid {
        display: grid;
        grid-template-columns: var(--gutter) repeat(7, minmax(var(--min-col), 1fr));
        grid-template-rows: auto calc(var(--hour) * 24);
        min-width: min-content;
      }
      .corner,
      .day-head {
        position: sticky;
        top: 0;
        z-index: 4;
        background: var(--pc-card);
        border-bottom: 1px solid var(--pc-divider);
      }
      .corner {
        left: 0;
        z-index: 5;
      }
      .day-head {
        display: flex;
        justify-content: center;
        padding: 10px 4px;
        font-weight: 500;
        color: var(--pc-text-2);
        border-left: 1px solid var(--pc-divider);
      }
      .day-head.today .dname {
        color: var(--pc-on-primary);
        background: var(--pc-primary);
        border-radius: 12px;
        padding: 0 10px;
      }
      .gutter {
        position: sticky;
        left: 0;
        z-index: 3;
        background: var(--pc-card);
      }
      .gutter span {
        position: absolute;
        right: 6px;
        transform: translateY(-50%);
        font-size: 0.72em;
        color: var(--pc-text-2);
        white-space: nowrap;
      }
      .col {
        position: relative;
        border-left: 1px solid var(--pc-divider);
        background-image:
          linear-gradient(to bottom, var(--pc-divider) 1px, transparent 1px),
          linear-gradient(to bottom, var(--pc-minor) 1px, transparent 1px);
        background-size:
          100% var(--hour),
          100% calc(var(--hour) / 4);
        touch-action: pan-x pan-y;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        cursor: crosshair;
      }
      .col.today {
        background-color: color-mix(in srgb, var(--pc-primary) 4%, transparent);
      }
      .col::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        right: 0;
        width: var(--strip);
        pointer-events: none;
        transition: background 0.15s;
      }
      .col:hover::after {
        background: repeating-linear-gradient(
          135deg,
          transparent 0 6px,
          color-mix(in srgb, var(--pc-primary) 8%, transparent) 6px 12px
        );
      }
      .block {
        position: absolute;
        left: calc((100% - var(--strip)) * var(--left) + 2px);
        width: calc((100% - var(--strip)) * var(--width) - 4px);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        padding: 3px 6px;
        overflow: hidden;
        text-align: left;
        border: none;
        border-left: 4px solid var(--block-color);
        border-radius: 6px;
        background: color-mix(in srgb, var(--block-color) 22%, var(--pc-card));
        color: var(--pc-text);
        font-size: 0.8em;
        line-height: 1.25;
        cursor: pointer;
        z-index: 1;
      }
      .block:hover {
        background: color-mix(in srgb, var(--block-color) 32%, var(--pc-card));
      }
      .block.active {
        background: color-mix(in srgb, var(--block-color) 42%, var(--pc-card));
        box-shadow: inset 0 0 0 1px var(--block-color);
      }
      .block.waiting {
        background-image: repeating-linear-gradient(
          135deg,
          transparent 0 6px,
          color-mix(in srgb, var(--pc-text) 7%, transparent) 6px 12px
        );
      }
      .block.selected {
        outline: 2px solid var(--block-color);
        outline-offset: 1px;
        z-index: 2;
      }
      .block.continuation {
        border-top-left-radius: 0;
        border-top-right-radius: 0;
        border-top: 2px dashed var(--block-color);
      }
      .block.continues {
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
        border-bottom: 2px dashed var(--block-color);
      }
      .block.compact {
        flex-direction: row;
        align-items: center;
        gap: 6px;
        padding-top: 0;
        padding-bottom: 0;
      }
      .block.compact .time {
        display: none;
      }
      .name {
        font-weight: 500;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .time {
        color: var(--pc-text-2);
        white-space: nowrap;
      }
      .badges {
        display: flex;
        gap: 2px;
        color: var(--pc-text-2);
      }
      .badges .warn {
        color: var(--pc-warning);
      }
      .picking .block {
        cursor: copy;
      }
      .picking .block:hover {
        outline: 2px dashed var(--pc-primary);
      }
      .picking .col {
        cursor: default;
      }
      .ghost {
        position: absolute;
        left: 2px;
        right: 2px;
        z-index: 3;
        padding: 3px 6px;
        border-radius: 6px;
        border: 2px dashed var(--pc-primary);
        background: color-mix(in srgb, var(--pc-primary) 22%, transparent);
        font-size: 0.8em;
        font-weight: 500;
        pointer-events: none;
      }
      .now {
        position: absolute;
        left: 0;
        right: 0;
        height: 2px;
        background: var(--pc-error);
        z-index: 2;
        pointer-events: none;
      }
      .now::before {
        content: "";
        position: absolute;
        left: -5px;
        top: -4px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--pc-error);
      }
      @media (max-width: 600px) {
        :host {
          --gutter: 44px;
          --min-col: 96px;
        }
      }
    `,
  ];
}
