// Google-Calendar-style layout of overlapping blocks within one day column.

export interface LayoutInput {
  id: string;
  start: number;
  end: number;
  seq: number;
}

export interface Placed {
  id: string;
  start: number;
  end: number;
  /** Left edge as a fraction of the usable column width. */
  left: number;
  /** Width as a fraction of the usable column width. */
  width: number;
}

interface Work extends LayoutInput {
  vEnd: number;
  col: number;
}

/**
 * Place items so overlapping ones sit side by side. Items that don't overlap
 * anything are full width; an item expands right over columns that are free
 * for its whole time range.
 *
 * `minVisual` is the minimum drawn height in minutes; very short blocks count
 * as that tall when deciding what overlaps, so their labels don't collide.
 */
export function layoutDay(items: LayoutInput[], minVisual = 0): Placed[] {
  const sorted: Work[] = items
    .map((item) => ({ ...item, vEnd: Math.max(item.end, item.start + minVisual), col: 0 }))
    .sort((a, b) => a.start - b.start || b.vEnd - a.vEnd || a.seq - b.seq);

  const placed: Placed[] = [];
  let cluster: Work[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columns: number[] = []; // last vEnd per column
    for (const item of cluster) {
      let col = columns.findIndex((end) => end <= item.start);
      if (col === -1) {
        col = columns.length;
        columns.push(item.vEnd);
      } else {
        columns[col] = item.vEnd;
      }
      item.col = col;
    }
    const n = columns.length;
    for (const item of cluster) {
      let span = 1;
      for (let c = item.col + 1; c < n; c++) {
        const blocked = cluster.some(
          (other) => other.col === c && other.start < item.vEnd && item.start < other.vEnd,
        );
        if (blocked) break;
        span++;
      }
      placed.push({
        id: item.id,
        start: item.start,
        end: item.end,
        left: item.col / n,
        width: span / n,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.vEnd);
  }
  flush();
  return placed;
}
