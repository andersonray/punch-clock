import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { Block, Config, HomeAssistant, Status } from "../types";
import {
  MINUTES_PER_DAY,
  SNAP_MINUTES,
  clamp,
  dayName,
  displayDays,
  formatHour,
  formatRange,
  nowIn,
  segments,
  snapCeil,
  snapFloor,
  snapRound,
  type Segment,
  type WallClock,
} from "../logic/time";
import { layoutDay, type Placed } from "../logic/layout";
import { blockLabel, countConditions, findConflicts, type Conflict } from "../logic/model";
import { controls } from "../styles";
import { icon, mdiAlertOutline, mdiFilterOff, mdiFilterVariant } from "../icons";

/** A block's day and times. The start is a minute of the day; it may run past midnight. */
export interface CreateBlockDetail {
  day: number;
  start: number;
  duration: number;
}

/** New times for a block whose top or bottom edge was dragged. */
export interface ResizeBlockDetail extends CreateBlockDetail {
  blockId: string;
}

interface Drag {
  /** Drawing out a new block, or moving an existing block's start or end. */
  kind: "create" | "start" | "end";
  /** The block whose start or end is moving. */
  block: Block | null;
  /**
   * Positions are minutes from midnight at the start of this day. Over the next day's column
   * they're past 1440, and over the previous day's they're negative.
   */
  day: number;
  /** Where a new block was started, or the end of the block that stays put. */
  anchor: number;
  /** The column the drag started in. */
  col: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
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
/** Pressing on a block's edge is meant to move it, so a smaller movement counts. */
const RESIZE_TOLERANCE_PX = 3;
const EDGE_SCROLL_PX = 48;
const MIN_BLOCK_PX = 18;
/** Space left below every block, so back-to-back blocks don't run together. */
const BLOCK_GAP_PX = 2;

/**
 * The week calendar for one tab. Days are columns, time runs down. Blocks that
 * overlap in time share the column width; a strip on the right of every column
 * stays free so new blocks can always be dragged out. Dragging a block's top or
 * bottom edge changes its start or end. While drawing out a block or dragging an
 * edge, the pointer can move into the next or previous day's column to cross midnight.
 *
 * Events: `create-block` (CreateBlockDetail), `resize-block` (ResizeBlockDetail),
 * `select-block` / `pick-block` ({ blockId }), `background-click`.
 */
export class PcWeekView extends LitElement {
  static override properties = {
    hass: { attribute: false },
    config: { attribute: false },
    tabId: {},
    status: { attribute: false },
    selectedIds: { attribute: false },
    picking: { type: Boolean },
    use24h: { type: Boolean },
    language: {},
    timeZone: {},
    hourHeight: { type: Number },
    initialHour: { type: Number },
    _span: { state: true },
    _now: { state: true },
  };

  declare hass: HomeAssistant;
  declare config: Config;
  declare tabId: string;
  declare status: Status | null;
  /** The selected block and the rest of its group. */
  declare selectedIds: string[];
  /** Eyedropper mode: clicking a block picks it instead of selecting it. */
  declare picking: boolean;
  declare use24h: boolean;
  declare language: string;
  declare timeZone: string;
  declare hourHeight: number;
  /** Hour to scroll to initially; negative means "an hour before now". */
  declare initialHour: number;
  /** The times being dragged out: the new block's, or those of the block being resized. */
  declare _span: CreateBlockDetail | null;
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
    this.selectedIds = [];
    this.picking = false;
    this.use24h = false;
    this.language = "en";
    this.timeZone = "UTC";
    this.hourHeight = 48;
    this.initialHour = -1;
    this._span = null;
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

  // --- Dragging: new blocks and block edges -----------------------------------

  private minuteAt(col: HTMLElement, clientY: number): number {
    const rect = col.getBoundingClientRect();
    return clamp(((clientY - rect.top) / this.hourHeight) * 60, 0, MINUTES_PER_DAY);
  }

  /** The day column under the pointer, or null if the columns aren't laid out. */
  private columnAt(clientX: number): HTMLElement | null {
    const cols = [...this.renderRoot.querySelectorAll<HTMLElement>(".col")];
    for (const [i, col] of cols.entries()) {
      const rect = col.getBoundingClientRect();
      if (!rect.width) return null;
      if (clientX < rect.right || i === cols.length - 1) return col;
    }
    return null;
  }

  /**
   * The pointer's position in minutes from midnight at the start of `drag.day`. Columns
   * further away than the next or previous day count as two days off, which the drag's
   * 24-hour limit then clamps.
   */
  private positionAt(drag: Drag, clientX: number, clientY: number): number {
    const col = this.columnAt(clientX) ?? drag.col;
    const ahead = (Number(col.dataset.day) - drag.day + 7) % 7;
    let offset = ahead === 0 ? 0 : ahead === 1 ? 1 : ahead === 6 ? -1 : 0;
    if (ahead > 1 && ahead < 6) {
      offset = Number(col.dataset.index) > Number(drag.col.dataset.index) ? 2 : -2;
    }
    return offset * MINUTES_PER_DAY + this.minuteAt(col, clientY);
  }

  /** The block times a drag to `position` gives: at least 15 minutes, at most 24 hours. */
  private spanAt(drag: Drag, position: number): CreateBlockDetail {
    const anchor = drag.anchor;
    let start: number;
    let end: number;
    if (drag.kind === "start") {
      end = anchor;
      start = clamp(snapRound(position), end - MINUTES_PER_DAY, end - SNAP_MINUTES);
    } else if (drag.kind === "end") {
      start = anchor;
      end = clamp(snapRound(position), start + SNAP_MINUTES, start + MINUTES_PER_DAY);
    } else if (position >= anchor) {
      start = anchor;
      end = Math.min(Math.max(anchor + SNAP_MINUTES, snapCeil(position)), start + MINUTES_PER_DAY);
    } else {
      end = anchor + SNAP_MINUTES;
      start = Math.max(snapFloor(position), end - MINUTES_PER_DAY);
    }
    const days = Math.floor(start / MINUTES_PER_DAY);
    return {
      day: (((drag.day + days) % 7) + 7) % 7,
      start: start - days * MINUTES_PER_DAY,
      duration: end - start,
    };
  }

  private beginDrag(drag: Drag, pointerId: number | null): void {
    this.drag = drag;
    // Capture on the scroller, which outlives the block and column elements a drag redraws.
    if (pointerId !== null) this.scroller.setPointerCapture?.(pointerId);
    this._span = drag.block
      ? { day: drag.block.day, start: drag.block.start, duration: drag.block.duration }
      : this.spanAt(drag, drag.anchor);
    window.addEventListener("keydown", this.onDragKey);
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  }

  private beginCreate(
    day: number,
    col: HTMLElement,
    clientX: number,
    clientY: number,
    pointerId: number | null,
  ): void {
    const touch = pointerId === null;
    const anchor = Math.min(snapFloor(this.minuteAt(col, clientY)), MINUTES_PER_DAY - SNAP_MINUTES);
    this.beginDrag(
      {
        kind: "create",
        block: null,
        day,
        anchor,
        col,
        startX: clientX,
        startY: clientY,
        lastX: clientX,
        lastY: clientY,
        moved: touch,
        touch,
      },
      pointerId,
    );
  }

  private updateDrag(clientX: number, clientY: number): void {
    const drag = this.drag;
    if (!drag) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const tolerance = drag.block ? RESIZE_TOLERANCE_PX : MOVE_TOLERANCE_PX;
    if (Math.hypot(clientX - drag.startX, clientY - drag.startY) > tolerance) drag.moved = true;
    // Until an edge really moves, leave the block alone (its times may be off the 15-minute grid).
    if (drag.block && !drag.moved) return;
    this._span = this.spanAt(drag, this.positionAt(drag, clientX, clientY));
  }

  private finishDrag(): void {
    const drag = this.drag;
    const span = this._span;
    if (!drag || !span) {
      this.cancelDrag();
      return;
    }
    const block = drag.block;
    this.suppressClickUntil = performance.now() + 400;
    if (!block) {
      if (drag.moved) this.fire<CreateBlockDetail>("create-block", span);
      else this.fire("background-click");
    } else if (
      drag.moved &&
      (span.day !== block.day || span.start !== block.start || span.duration !== block.duration)
    ) {
      this.fire<ResizeBlockDetail>("resize-block", { blockId: block.id, ...span });
    } else {
      // Pointer capture keeps the click from reaching the block, so this is the click.
      this.fire(this.picking ? "pick-block" : "select-block", { blockId: block.id });
    }
    // After the event, so the panel shows the new times in the same update.
    this.cancelDrag();
  }

  private cancelDrag(): void {
    cancelAnimationFrame(this.scrollFrame);
    window.removeEventListener("keydown", this.onDragKey);
    if (this.press) window.clearTimeout(this.press.timer);
    this.press = null;
    this.drag = null;
    this._span = null;
  }

  private readonly onDragKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.drag) return;
    e.preventDefault();
    this.cancelDrag();
  };

  private readonly autoScroll = (): void => {
    const drag = this.drag;
    if (!drag) return;
    const scroller = this.scroller;
    const rect = scroller.getBoundingClientRect();
    const head =
      (this.renderRoot.querySelector(".day-head") as HTMLElement | null)?.offsetHeight ?? 0;
    const gutter =
      (this.renderRoot.querySelector(".gutter") as HTMLElement | null)?.offsetWidth ?? 0;
    let dy = 0;
    if (drag.lastY < rect.top + head + EDGE_SCROLL_PX) dy = -12;
    else if (drag.lastY > rect.bottom - EDGE_SCROLL_PX) dy = 12;
    // On a narrow screen the week scrolls sideways too; follow a drag into the next day.
    let dx = 0;
    if (scroller.scrollWidth > scroller.clientWidth) {
      if (drag.lastX < rect.left + gutter + EDGE_SCROLL_PX) dx = -12;
      else if (drag.lastX > rect.right - EDGE_SCROLL_PX) dx = 12;
    }
    if (dy || dx) {
      scroller.scrollTop += dy;
      scroller.scrollLeft += dx;
      this.updateDrag(drag.lastX, drag.lastY);
    }
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  };

  private onPointerDown(e: PointerEvent, day: number): void {
    if (e.pointerType === "touch" || e.button !== 0 || this.picking) return;
    if ((e.target as HTMLElement).closest(".block")) return;
    e.preventDefault();
    this.beginCreate(day, e.currentTarget as HTMLElement, e.clientX, e.clientY, e.pointerId);
  }

  /** Pressing a block's top or bottom edge starts moving its start or end. */
  private onEdgeDown(e: PointerEvent, block: Block, kind: "start" | "end"): void {
    // Touch, other buttons and the eyedropper treat the edge as part of the block.
    if (e.pointerType === "touch" || e.button !== 0 || this.picking) return;
    e.preventDefault();
    e.stopPropagation();
    const col = (e.currentTarget as HTMLElement).closest<HTMLElement>(".col")!;
    this.beginDrag(
      {
        kind,
        block,
        day: block.day,
        anchor: kind === "start" ? block.start + block.duration : block.start,
        col,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        touch: false,
      },
      e.pointerId,
    );
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag && !this.drag.touch) this.updateDrag(e.clientX, e.clientY);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && !this.drag.touch) {
      this.scroller.releasePointerCapture?.(e.pointerId);
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
      this.beginCreate(day, col, touch.clientX, touch.clientY, null);
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
      this.updateDrag(touch.clientX, touch.clientY);
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

  private tabInactive(): boolean {
    const tab = this.status?.tabs[this.tabId];
    return tab !== undefined && !tab.active;
  }

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
    // The block's own conditions are false right now, so it wouldn't run (in or out of its window).
    const unmet = state !== undefined && !state.conditions_met;
    const classes = [
      "block",
      this.selectedIds.includes(block.id) ? "selected" : "",
      block.id === this.drag?.block?.id ? "resizing" : "",
      state?.active ? "active" : "",
      unmet ? "unmet" : "",
      height < 36 ? "compact" : "",
      seg.continuation ? "continuation" : "",
      seg.continues ? "continues" : "",
    ].join(" ");
    const label = blockLabel(block, this.hass?.states);
    const range = formatRange(block.start, block.duration, this.use24h);
    const conditionCount = countConditions(block.conditions);
    const day = dayName(block.day, this.language, "long");
    const notes = [
      state?.active ? "running now" : "",
      unmet ? "conditions not met right now, so it won't run" : "",
      this.tabInactive() ? "its tab isn't running" : "",
      conflicts?.length ? "conflicts with another block" : "",
      missing ? "uses an entity that doesn't exist" : "",
    ].filter(Boolean);
    return html`<button
      class=${classes}
      style="top:${top}px;height:${height - BLOCK_GAP_PX}px;--left:${placed.left};--width:${placed.width};--block-color:${block.color}"
      aria-label=${`${label}, ${day} ${range}${notes.length ? `, ${notes.join(", ")}` : ""}`}
      title=${`${label}\n${day} ${range}${notes.length ? `\n${notes.join("\n")}` : ""}`}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @touchstart=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => this.onBlockClick(e, block)}
    >
      <span class="name">${label}</span>
      <span class="time">${range}</span>
      <span class="badges">
        ${
          unmet
            ? html`<span class="unmet-badge" title="Conditions not met right now"
                >${icon(mdiFilterOff, 14)}</span
              >`
            : conditionCount
              ? html`<span title="Has conditions">${icon(mdiFilterVariant, 14)}</span>`
              : nothing
        }
        ${
          conflicts?.length || missing
            ? html`<span class="warn" title=${notes.join(", ")}>${icon(mdiAlertOutline, 14)}</span>`
            : nothing
        }
      </span>
      ${
        // The edges at midnight of a block that crosses it aren't its start or end.
        seg.continuation
          ? nothing
          : html`<span
              class="edge top"
              @pointerdown=${(e: PointerEvent) => this.onEdgeDown(e, block, "start")}
            ></span>`
      }
      ${
        seg.continues
          ? nothing
          : html`<span
              class="edge bottom"
              @pointerdown=${(e: PointerEvent) => this.onEdgeDown(e, block, "end")}
            ></span>`
      }
    </button>`;
  }

  private renderGhost(span: CreateBlockDetail, seg: Segment): TemplateResult {
    const hour = this.hourHeight;
    return html`<div
      class="ghost ${seg.continuation ? "continuation" : ""} ${seg.continues ? "continues" : ""}"
      style="top:${(seg.start / 60) * hour}px;height:${((seg.end - seg.start) / 60) * hour}px"
    >
      ${formatRange(span.start, span.duration, this.use24h)}
    </div>`;
  }

  private renderColumn(
    day: number,
    index: number,
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
    const span = this.drag?.kind === "create" ? this._span : null;
    const ghosts = span
      ? segments(span.day, span.start, span.duration).filter((seg) => seg.day === day)
      : [];
    const today = this._now.day === day;
    return html`<div
      class="col ${today ? "today" : ""}"
      data-day=${day}
      data-index=${index}
      @pointerdown=${(e: PointerEvent) => this.onPointerDown(e, day)}
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
      ${ghosts.map((seg) => this.renderGhost(span!, seg))}
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
    // A block whose edge is being dragged is drawn with its new times.
    const resizing = this.drag?.block && this._span ? this.drag.block.id : null;
    const blocks = this.config.blocks
      .filter((b) => b.tab_id === this.tabId)
      .map((b) => (b.id === resizing ? { ...b, ...this._span } : b));
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
      class="scroller ${this.picking ? "picking" : ""} ${this.tabInactive() ? "tab-off" : ""} ${resizing ? "resizing" : ""}"
      style="--hour:${this.hourHeight}px"
      @pointermove=${this.onPointerMove}
      @pointerup=${this.onPointerUp}
      @pointercancel=${() => this.cancelDrag()}
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
        ${days.map((d, i) => this.renderColumn(d, i, byDay.get(d) ?? [], conflicts))}
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
      /*
       * Hatched = won't run right now: its own conditions aren't met (those also get the
       * badge), or its whole tab isn't running. Kept on hover, which resets background.
       */
      .block.unmet,
      .block.unmet:hover,
      .tab-off .block,
      .tab-off .block:hover {
        background-image: repeating-linear-gradient(
          135deg,
          transparent 0 5px,
          color-mix(in srgb, var(--pc-text) 10%, transparent) 5px 10px
        );
      }
      .badges .unmet-badge {
        color: var(--pc-warning);
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
      /* Drag a block's top or bottom edge to move its start or end. */
      .edge {
        position: absolute;
        left: 0;
        right: 0;
        height: 6px;
        cursor: ns-resize;
      }
      .edge.top {
        top: 0;
      }
      .edge.bottom {
        bottom: 0;
      }
      .edge::after {
        content: "";
        position: absolute;
        left: 50%;
        width: 20px;
        height: 2px;
        margin-left: -10px;
        border-radius: 1px;
        background: var(--block-color);
        opacity: 0;
        transition: opacity 0.1s;
      }
      .edge.top::after {
        top: 2px;
      }
      .edge.bottom::after {
        bottom: 2px;
      }
      .edge:hover::after,
      .block.resizing .edge::after {
        opacity: 1;
      }
      .block.resizing {
        z-index: 2;
      }
      .scroller.resizing,
      .scroller.resizing * {
        cursor: ns-resize !important;
      }
      .picking .block {
        cursor: copy;
      }
      .picking .edge {
        cursor: inherit;
      }
      .picking .edge::after {
        display: none;
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
      .ghost.continuation {
        border-top-left-radius: 0;
        border-top-right-radius: 0;
      }
      .ghost.continues {
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
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
