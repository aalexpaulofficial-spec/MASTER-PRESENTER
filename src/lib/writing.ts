/**
 * Master Write — the pure logic behind hand-controlled writing.
 *
 * Nothing in this file touches React, the DOM or the camera, so the gesture
 * state machine, the geometry helpers and the eraser can all be exercised
 * without a browser. See scripts/writing-gestures.test.ts.
 *
 * The rule that shapes everything here (§1 §5 §9): INDEX + MIDDLE is the ONLY
 * gesture that opens the writing toolbar, and it never writes by itself. A lone
 * index finger is the pen once a colour is armed; it selects from the toolbar by
 * dwelling and writes by moving. The toolbar STAYS on screen while the presenter
 * works (§5 §11) and only the MINUS button hides it (§6); while it is open and
 * the presenter re-raises their index finger to write, the toolbar stays visible
 * and the pen writes right under it (selecting mode, §7), and INDEX + MIDDLE
 * re-enters select mode / reopens it. There is no laser (§13 §24).
 */

export type WritingPoint = { x: number; y: number };

/** One continuous fingertip line, stored in slide space (0..1 on both axes). */
export type WritingStroke = {
  id: string;
  color: string;
  points: WritingPoint[];
};

/** The five writing colours. */
export type WritingColor = "color-0" | "color-1" | "color-2" | "color-3" | "color-4";

/** Everything the one toolbar offers: five colours, then the tool buttons. */
export type WriteMenuItem =
  WritingColor | "manual-eraser" | "clear-all" | "undo" | "redo" | "minimize";

/** Red, blue, green, yellow, white — the five writing colours (§2). */
export const WRITING_COLORS = ["#ef4444", "#2563eb", "#16a34a", "#eab308", "#ffffff"] as const;

/** The colour swatches, in toolbar order. */
export const WRITING_COLOR_ORDER: readonly WritingColor[] = [
  "color-0",
  "color-1",
  "color-2",
  "color-3",
  "color-4",
];

/** The eraser half of the toolbar: Manual Eraser, then Erase All (§9 §10 §12). */
export const ERASER_MENU_ITEMS: readonly WriteMenuItem[] = ["manual-eraser", "clear-all"];

/** The history / view buttons: Undo, Redo, Minimize (§13 §14 §6). */
export const TOOL_MENU_ITEMS: readonly WriteMenuItem[] = ["undo", "redo", "minimize"];

/** Everything on the single writing toolbar, left to right (§2). */
export const WRITE_TOOLBAR_ITEMS: readonly WriteMenuItem[] = [
  ...WRITING_COLOR_ORDER,
  ...ERASER_MENU_ITEMS,
  ...TOOL_MENU_ITEMS,
];

export function colorValue(color: WritingColor): string {
  return WRITING_COLORS[Number(color.slice("color-".length))] ?? WRITING_COLORS[0];
}

/** How far the manual eraser reaches, in slide-space units. */
export const ERASER_RADIUS = 0.035;

/** Shortest distance from `point` to the segment a-b. */
export function distanceToSegment(point: WritingPoint, a: WritingPoint, b: WritingPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** True when any part of the stroke falls inside the eraser disc. */
export function strokeNearPoint(
  stroke: WritingStroke,
  point: WritingPoint,
  radius: number,
): boolean {
  const first = stroke.points[0];
  if (!first) return false;
  if (stroke.points.length === 1) {
    return Math.hypot(first.x - point.x, first.y - point.y) <= radius;
  }
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    if (a && b && distanceToSegment(point, a, b) <= radius) return true;
  }
  return false;
}

/**
 * Cuts the eraser disc out of one stroke and returns whatever survives, so the
 * presenter can rub out the middle of a line and keep both ends.
 */
function splitStrokeAroundPoint(
  stroke: WritingStroke,
  point: WritingPoint,
  radius: number,
  makeId: () => string,
): WritingStroke[] {
  const pieces: WritingStroke[] = [];
  let run: WritingPoint[] = [];
  const flush = () => {
    if (run.length >= 2) pieces.push({ id: makeId(), color: stroke.color, points: run });
    run = [];
  };

  let previous: WritingPoint | null = null;
  for (const current of stroke.points) {
    if (Math.hypot(current.x - point.x, current.y - point.y) <= radius) {
      flush();
      previous = null;
      continue;
    }
    // Both ends survived but the line between them ran through the eraser.
    if (previous && distanceToSegment(point, previous, current) <= radius) flush();
    run.push(current);
    previous = current;
  }
  flush();
  return pieces;
}

/**
 * Removes only the parts of the annotations the fingertip passed over (§9).
 * Returns the original array untouched when nothing was hit, so callers can
 * skip a re-render. PPT text, images, shapes and backgrounds are never touched
 * — this only ever sees Master Write's own overlay strokes.
 */
export function eraseFromStrokes(
  strokes: WritingStroke[],
  point: WritingPoint,
  radius: number,
  makeId: () => string,
): WritingStroke[] {
  let erased = false;
  const next: WritingStroke[] = [];
  for (const stroke of strokes) {
    if (!strokeNearPoint(stroke, point, radius)) {
      next.push(stroke);
      continue;
    }
    erased = true;
    for (const piece of splitStrokeAroundPoint(stroke, point, radius, makeId)) next.push(piece);
  }
  return erased ? next : strokes;
}

/* -------------------------------------------------------------------------- *
 * Gesture state machine (§12)
 * -------------------------------------------------------------------------- */

/**
 * idle     no writing gesture — hand down or tracking lost
 * select   toolbar open, no tool armed yet — fingertip is a selector only (§3)
 * ready    a tool is armed, fingertip is a pen/eraser cursor, no ink yet (§4 §5)
 * writing  a deliberate fingertip movement is drawing a stroke (§6)
 * erasing  a deliberate fingertip sweep is rubbing marks out (§9)
 */
export type WriteState = "idle" | "select" | "ready" | "writing" | "erasing";

/** Which hand gesture is driving this frame. Both raise the same toolbar. */
export type WriteGesture = "none" | "index" | "eraser";

/** Which tool the fingertip is currently armed with. */
export type WriteTool = "pen" | "eraser";

export type WriteSample = {
  /** index = index finger only, eraser = index + middle, none = neither. */
  gesture: WriteGesture;
  /** The INDEX FINGERTIP in slide space (landmark 8), or null when absent (§7). */
  point: WritingPoint | null;
  /** The toolbar item directly under the fingertip, while the toolbar is open. */
  hit: WriteMenuItem | null;
  now: number;
};

export type WriteEffect =
  | { kind: "select-color"; color: WritingColor }
  | { kind: "select-eraser" }
  | { kind: "clear" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "minimize" }
  | { kind: "erase-begin" }
  | { kind: "erase-end" }
  | { kind: "begin"; point: WritingPoint }
  | { kind: "extend"; point: WritingPoint }
  | { kind: "erase"; point: WritingPoint }
  | { kind: "end" };

/**
 * How the fingertip cursor should look. The `-active` variants mean a stroke or
 * an erase is happening right now, so the presenter can see the difference
 * between pointing and writing (§3 §5).
 */
export type CursorMode = "select" | "pen" | "pen-active" | "eraser" | "eraser-active" | null;

export type WriteFrame = {
  state: WriteState;
  /** True while the single writing toolbar is on screen (§2 §11). */
  toolbarOpen: boolean;
  hovered: WriteMenuItem | null;
  /** Dwell progress on the hovered item, 0..1. */
  dwell: number;
  cursor: WritingPoint | null;
  cursorMode: CursorMode;
  /** The armed tool, so the toolbar can show which one is live. */
  tool: WriteTool;
  effects: WriteEffect[];
};

export const WRITE_TIMINGS = {
  /** Fingertip rest needed to pick a toolbar item. */
  dwellMs: 460,
  /**
   * The deliberate-writing threshold (§5): the fingertip must travel this far
   * inside `activateMs` for a stroke to start. Small enough to feel immediate,
   * big enough that a parked finger is a cursor and nothing else.
   */
  activateDist: 0.008,
  activateMs: 220,
  /** Holding still this long lifts the pen again, without lowering the finger. */
  idleEndMs: 400,
  /** Once a stroke is open, ink follows the fingertip down to this step (§6 §8). */
  minStep: 0.0015,
  /** A jump wider than this is a tracking glitch, not a stroke. */
  rejoinDist: 0.09,
  /**
   * After a pick the fingertip has to travel to wherever the presenter wants to
   * work, and that travel must not leave a mark (§4). So the tool only re-arms
   * once the fingertip has held inside `settleDist` for `settleMs` — which is
   * what arriving somewhere looks like. Short enough to feel immediate.
   */
  settleMs: 100,
  settleDist: 0.02,
  /** A tracking blink shorter than this never breaks a stroke (§6). */
  lostMs: 160,
  /** Frames an index<->index+middle switch must hold before it counts (§12 §10). */
  gestureHoldFrames: 3,
};

export type WriteTimings = typeof WRITE_TIMINGS;

/** Straight-line distance between two slide-space points. */
function gap(a: WritingPoint, b: WritingPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Turns the index-fingertip stream into toolbar, writing and erasing decisions.
 * Call `update` once per camera frame; every side effect is returned rather than
 * performed, which keeps the machine testable and the render loop imperative.
 */
export class WriteGestureMachine {
  private tool: WriteTool = "pen";
  private toolbarOpen = false;
  /** True while the toolbar is up and the presenter should be picking, not writing. */
  private selecting = false;
  private armed = false;
  private erasing = false;
  private strokeOpen = false;
  private hovered: WriteMenuItem | null = null;
  private hoverStart = 0;
  private justPicked = false;
  private lostAt = 0;
  private lastPoint: WritingPoint | null = null;
  /** False until the fingertip has settled after a pick — no ink before that. */
  private settledOnce = false;
  private settleFrom: WritingPoint | null = null;
  private settleAt = 0;
  /** Where the current movement window started, and when. */
  private anchor: WritingPoint | null = null;
  private anchorAt = 0;
  private moveFrom: WritingPoint | null = null;
  private lastMoveAt = 0;
  private now = 0;
  /** Debounced gesture, so one misread frame never switches tools (§12). */
  private heldGesture: WriteGesture = "none";
  private pendingGesture: WriteGesture = "none";
  private pendingCount = 0;
  /** Consecutive RAW index + middle frames, per the camera's own report. */
  private eraserRun = 0;
  /** The previous frame's raw camera gesture, used to spot a fresh lone-index raise. */
  private lastRawGesture: WriteGesture = "none";
  private state: WriteState = "idle";
  private readonly timings: WriteTimings;

  // A plain field assignment (not a parameter property) so the whole module
  // stays runnable under Node's strip-only type removal — see the test header.
  constructor(timings: WriteTimings = WRITE_TIMINGS) {
    this.timings = timings;
  }

  /** Drops anything in flight — used when the slide changes (§14). */
  reset(): void {
    this.tool = "pen";
    this.toolbarOpen = false;
    this.selecting = false;
    this.armed = false;
    this.erasing = false;
    this.strokeOpen = false;
    this.hovered = null;
    this.hoverStart = 0;
    this.justPicked = false;
    this.lostAt = 0;
    this.lastPoint = null;
    this.settledOnce = false;
    this.settleFrom = null;
    this.settleAt = 0;
    this.anchor = null;
    this.anchorAt = 0;
    this.moveFrom = null;
    this.lastMoveAt = 0;
    this.heldGesture = "none";
    this.pendingGesture = "none";
    this.pendingCount = 0;
    this.eraserRun = 0;
    this.lastRawGesture = "none";
    this.state = "idle";
  }

  /** Hides the toolbar on demand (minus button) without dropping the armed tool. */
  requestMinimize(): void {
    this.toolbarOpen = false;
    this.selecting = false;
    this.hovered = null;
    this.hoverStart = 0;
    this.justPicked = false;
  }

  /** Arms a color directly (e.g. on mouse click) without resetting toolbar state. */
  armColor(_color: WritingColor): void {
    this.tool = "pen";
    this.armed = true;
    this.selecting = false;
  }

  /** Arms a tool directly (e.g. manual-eraser) without resetting toolbar state. */
  armTool(tool: WriteTool): void {
    this.tool = tool;
    this.armed = true;
    this.selecting = false;
  }

  update(sample: WriteSample): WriteFrame {
    const effects: WriteEffect[] = [];
    this.now = sample.now;
    const gesture = this.stableGesture(sample.gesture);
    const rawGesture = sample.gesture;
    // A transition of the RAW gesture — what the camera reported this frame vs.
    // last — gates the one-shot toolbar toggle and the lone-index hand-back (§10).
    const rawSwitched = rawGesture !== this.lastRawGesture;
    this.lastRawGesture = rawGesture;

    // Count consecutive RAW index + middle frames, so the toolbar toggle fires
    // exactly once per raise and a one-frame misread never toggles it (§10 §12).
    if (rawGesture === "eraser") this.eraserRun += 1;
    else this.eraserRun = 0;

    if (gesture === "none" || !sample.point) {
      return this.handleRelease(effects, sample.now);
    }
    this.lostAt = 0;

    // INDEX + MIDDLE is the toolbar control gesture (§1 §9 §10). It fires exactly
    // once per raise — on the third held frame, so a one-frame misread never
    // toggles the toolbar — and holding it never re-opens it again (§7 §10).
    if (gesture === "eraser" && this.eraserRun === this.timings.gestureHoldFrames) {
      this.openToolbar(effects, sample.now, sample.point);
    }

    const point = sample.point;
    if (this.toolbarOpen) {
      if (sample.hit) return this.handleHover(effects, sample.hit, point, sample.now);
      this.hovered = null;
      this.justPicked = false;
    }

    // With a tool already armed and the toolbar up in SELECT mode, a lone index
    // finger re-raises to go straight back to writing — the toolbar stays on
    // screen (§5 §7 §11), it does NOT step aside and vanish (new spec). The
    // `selecting` flag tells the renderer to withhold the toolbar hit-test and
    // let the armed pen/eraser write where the fingertip moves. The gesture has
    // to be a fresh raise (`rawSwitched`) so the flicker window (§12) never
    // flips the mode on its own.
    if (
      gesture === "index" &&
      rawSwitched &&
      this.toolbarOpen &&
      this.armed &&
      !this.strokeOpen &&
      !this.erasing &&
      !this.selecting &&
      this.eraserRun === 0
    ) {
      this.selecting = true;
      this.hovered = null;
      this.hoverStart = 0;
      this.justPicked = false;
      this.settleFrom = point;
      this.settleAt = this.now;
      this.settledOnce = false;
      this.anchor = null;
      this.anchorAt = 0;
      this.moveFrom = null;
      this.lastMoveAt = 0;
      this.state = "ready";
    }

    // Selecting mode (toolbar up, but the presenter has re-raised the index finger
    // to write): the fingertip is the pen again, NOT a toolbar selector, so we
    // skip the hover path above and fall through to writing/erasing (§5 §7 §11).
    // INDEX FINGER ONLY writes — INDEX + MIDDLE never writes (§1 §5).
    if (this.selecting) {
      if (!this.armed) return this.frame(effects, point);
      if (gesture === "index" && this.tool === "pen") return this.handleWrite(effects, point, sample.now);
      if (gesture === "index" && this.tool === "eraser") return this.handleErase(effects, point, sample.now);
      return this.frame(effects, point);
    }

    // Without a tool armed the fingertip is only a cursor — and with no toolbar
    // at all it is also nothing but a cursor — either way it never writes (§1 §5).
    if (!this.toolbarOpen && !this.armed) {
      return this.frame(effects, point);
    }
    if (!this.armed) return this.frame(effects, point);
    // INDEX FINGER ONLY writes/erases — INDEX + MIDDLE never writes.
    if (gesture === "index" && this.tool === "pen") return this.handleWrite(effects, point, sample.now);
    if (gesture === "index" && this.tool === "eraser") return this.handleErase(effects, point, sample.now);
    return this.frame(effects, point);
  }

  /**
   * Index and index+middle look alike for a frame or two when a finger is on the
   * way up, so a real gesture change has to hold before it counts. Losing the
   * hand, and getting it back, are honoured at once — `lostMs` covers those.
   */
  private stableGesture(gesture: WriteGesture): WriteGesture {
    const held = this.heldGesture;
    if (gesture === held) {
      this.pendingGesture = gesture;
      this.pendingCount = 0;
      return gesture;
    }
    if (gesture === "none" || held === "none") {
      this.heldGesture = gesture;
      this.pendingGesture = gesture;
      this.pendingCount = 0;
      return gesture;
    }
    // A real gesture change has to hold for `gestureHoldFrames` frames before it
    // counts, so one or two misread frames never flip the controller (§12 §10).
    if (gesture !== this.pendingGesture) {
      this.pendingGesture = gesture;
      this.pendingCount = 1;
    } else {
      this.pendingCount += 1;
    }
    if (this.pendingCount < this.timings.gestureHoldFrames) return held;
    this.heldGesture = gesture;
    this.pendingCount = 0;
    return gesture;
  }

  /** Ends any open stroke or erase cleanly, emitting the matching effect. */
  private finishActive(effects: WriteEffect[]): void {
    if (this.strokeOpen) {
      effects.push({ kind: "end" });
      this.strokeOpen = false;
      this.lastPoint = null;
    }
    if (this.erasing) {
      effects.push({ kind: "erase-end" });
      this.erasing = false;
    }
  }

  /** No writing gesture: hand down, fist, palm, or tracking lost. */
  private handleRelease(effects: WriteEffect[], now: number): WriteFrame {
    if (
      this.strokeOpen ||
      this.erasing ||
      this.toolbarOpen ||
      this.armed ||
      this.state !== "idle"
    ) {
      // A tracking blink must not chop one movement into two strokes (§6).
      if (this.lostAt === 0) this.lostAt = now;
      if (now - this.lostAt <= this.timings.lostMs) return this.frame(effects, null);
      this.finishActive(effects);
      this.state = "idle";
      this.hovered = null;
      this.hoverStart = 0;
      this.justPicked = false;
      this.lastPoint = null;
      this.anchor = null;
      this.anchorAt = 0;
      this.moveFrom = null;
      this.lastMoveAt = 0;
      this.settleFrom = null;
      this.settleAt = 0;
      // The toolbar, the armed tool and the active colour survive a hand drop
      // (§6 §23), so the presenter can keep writing the instant they return.
      this.settledOnce = this.armed;
    }
    return this.frame(effects, null);
  }

  /**
   * Brings the toolbar back as a SELECTOR — closing any stroke that was in
   * progress first (§9). The armed colour stays loaded so the presenter can keep
   * writing the moment they leave select mode (raise the index finger again).
   * The toolbar STAYS on screen while they work in the new spec (§5 §7 §11),
   * so INDEX+MIDDLE no longer hides it; it re-enters the picking state.
   */
  private openToolbar(effects: WriteEffect[], now: number, point: WritingPoint): void {
    const interrupted = this.strokeOpen || this.erasing;
    this.finishActive(effects);
    this.toolbarOpen = true;
    this.selecting = false;
    this.hovered = null;
    this.hoverStart = 0;
    this.justPicked = false;
    this.anchor = null;
    this.anchorAt = 0;
    this.moveFrom = null;
    this.lastMoveAt = 0;
    this.settleFrom = point;
    this.settleAt = now;
    this.settledOnce = false;
    // Interrupting an active stroke or sweep hands the fingertip back to the
    // toolbar as a plain selector; re-opening while idle keeps the armed tool.
    if (interrupted) this.armed = false;
    this.state = !this.armed ? "select" : "ready";
  }

  /**
   * The toolbar owns the fingertip while it is the selector: dwell on an item to
   * use it. Re-picking the same item is suppressed until the finger leaves and
   * returns, so resting on a button never fires it twice (§2 §3).
   */
  private handleHover(
    effects: WriteEffect[],
    hit: WriteMenuItem,
    point: WritingPoint,
    now: number,
  ): WriteFrame {
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.hoverStart = now;
      this.justPicked = false;
    }
    if (this.justPicked) return this.frame(effects, point);
    if (now - this.hoverStart < this.timings.dwellMs) return this.frame(effects, point);

    // Picked. The toolbar STAYS on screen (§5 §11); the fingertip becomes the
    // armed tool — a cursor only, until it has settled and then moved (§4 §5).
    this.justPicked = true;
    return this.applyPick(hit, effects, point, now);
  }

  /** Turns a completed dwell into an armed tool, an action, or a view change. */
  private applyPick(
    hit: WriteMenuItem,
    effects: WriteEffect[],
    point: WritingPoint,
    now: number,
  ): WriteFrame {
    this.finishActive(effects);
    this.hovered = null;
    this.hoverStart = 0;
    this.justPicked = true;
    // Requiring a fresh settle stops the trip from the toolbar to the writing
    // spot — or a re-raise while the hand is moving — drawing a stray line (§4 §6).
    this.settleFrom = point;
    this.settleAt = now;
    this.settledOnce = false;
    this.anchor = null;
    this.anchorAt = 0;
    this.moveFrom = null;
    this.lastMoveAt = 0;

    if (hit === "minimize") {
      // Toolbar hides, but the armed tool and colour stay loaded so the presenter
      // keeps writing with their index finger while it is minimized (§6 §23).
      this.toolbarOpen = false;
      this.selecting = false;
      return this.frame(effects, point);
    }
    if (hit === "undo") {
      effects.push({ kind: "undo" });
      return this.frame(effects, point);
    }
    if (hit === "redo") {
      effects.push({ kind: "redo" });
      return this.frame(effects, point);
    }
    if (hit === "clear-all") {
      effects.push({ kind: "clear" });
      this.tool = "pen";
      this.armed = true;
      return this.frame(effects, point);
    }
    if (hit === "manual-eraser") {
      effects.push({ kind: "select-eraser" });
      this.tool = "eraser";
      this.armed = true;
      return this.frame(effects, point);
    }
    effects.push({ kind: "select-color", color: hit as WritingColor });
    this.tool = "pen";
    this.armed = true;
    return this.frame(effects, point);
  }

  /**
   * The gate between picking a tool and being allowed to mark the slide (§4).
   * The fingertip has to hold inside `settleDist` for `settleMs` — the shape of
   * arriving somewhere — so the trip from the toolbar to the writing spot, or a
   * re-raise while the hand is moving, can never draw.
   */
  private settled(point: WritingPoint, now: number): boolean {
    if (this.settledOnce) return true;
    const from = this.settleFrom;
    if (!from || gap(point, from) > this.timings.settleDist) {
      this.settleFrom = point;
      this.settleAt = now;
      return false;
    }
    if (now - this.settleAt < this.timings.settleMs) return false;
    this.settledOnce = true;
    this.settleFrom = null;
    this.anchor = point;
    this.anchorAt = now;
    return true;
  }

  /**
   * The deliberate-action test (§5). True the moment the fingertip has travelled
   * `activateDist` from where the current window started; the window slides
   * forward when it expires, so a slowly drifting hand never trips it.
   */
  private moved(point: WritingPoint, now: number): boolean {
    this.moveFrom = null;
    const anchor = this.anchor;
    if (!anchor) {
      this.anchor = point;
      this.anchorAt = now;
      return false;
    }
    if (gap(point, anchor) >= this.timings.activateDist) {
      this.moveFrom = anchor;
      this.anchor = point;
      this.anchorAt = now;
      this.lastMoveAt = now;
      return true;
    }
    if (now - this.anchorAt > this.timings.activateMs) {
      this.anchor = point;
      this.anchorAt = now;
    }
    return false;
  }

  /**
   * Pen cursor and ink (§5 §6). A parked fingertip is only a cursor; the first
   * deliberate movement opens a stroke at the point the movement started, so
   * nothing is clipped off the front of a letter. From then on ink follows the
   * fingertip every frame it clears `minStep`, which is what makes it real time.
   */
  private handleWrite(effects: WriteEffect[], point: WritingPoint, now: number): WriteFrame {
    if (!this.settled(point, now)) return this.frame(effects, point);
    const moving = this.moved(point, now);

    if (!this.strokeOpen) {
      if (!moving) {
        this.state = "ready";
        return this.frame(effects, point);
      }
      const from = this.moveFrom ?? point;
      effects.push({ kind: "begin", point: from }, { kind: "extend", point });
      this.strokeOpen = true;
      this.lastPoint = point;
      this.state = "writing";
      return this.frame(effects, point);
    }

    // Holding still lifts the pen — the finger can stay up between strokes.
    if (!moving && now - this.lastMoveAt > this.timings.idleEndMs) {
      effects.push({ kind: "end" });
      this.strokeOpen = false;
      this.lastPoint = null;
      this.state = "ready";
      return this.frame(effects, point);
    }

    const previous = this.lastPoint;
    if (previous) {
      const step = gap(point, previous);
      if (step > this.timings.rejoinDist) {
        effects.push({ kind: "end" }, { kind: "begin", point });
        this.lastPoint = point;
        return this.frame(effects, point);
      }
      if (step < this.timings.minStep) return this.frame(effects, point);
    }
    effects.push({ kind: "extend", point });
    this.lastPoint = point;
    return this.frame(effects, point);
  }

  /**
   * Manual Eraser (§9). Same deliberate-movement rule as the pen, so resting the
   * armed eraser over a mark never wipes it — the presenter has to sweep. A
   * whole sweep is bracketed by erase-begin / erase-end so it is one undo unit.
   */
  private handleErase(effects: WriteEffect[], point: WritingPoint, now: number): WriteFrame {
    if (!this.settled(point, now)) return this.frame(effects, point);
    const moving = this.moved(point, now);

    if (!this.erasing) {
      if (!moving) {
        this.state = "ready";
        return this.frame(effects, point);
      }
      effects.push({ kind: "erase-begin" });
      this.erasing = true;
      this.lastPoint = point;
      effects.push({ kind: "erase", point });
      return this.frame(effects, point);
    }

    if (!moving && now - this.lastMoveAt > this.timings.idleEndMs) {
      effects.push({ kind: "erase-end" });
      this.erasing = false;
      this.lastPoint = null;
      this.state = "ready";
      return this.frame(effects, point);
    }

    const previous = this.lastPoint;
    if (previous && gap(point, previous) < this.timings.minStep) {
      return this.frame(effects, point);
    }
    effects.push({ kind: "erase", point });
    this.lastPoint = point;
    return this.frame(effects, point);
  }

  /** Packages the public snapshot, including live dwell progress. */
  private frame(effects: WriteEffect[], cursor: WritingPoint | null): WriteFrame {
    let dwell = 0;
    if (this.toolbarOpen && this.hovered && this.hoverStart > 0) {
      dwell = clamp01((this.now - this.hoverStart) / this.timings.dwellMs);
    }
    let cursorMode: CursorMode = null;
    if (cursor) {
      if (this.erasing) cursorMode = "eraser-active";
      else if (this.strokeOpen) cursorMode = "pen-active";
      else if (this.tool === "eraser") cursorMode = "eraser";
      else if (this.armed) cursorMode = "pen";
      else cursorMode = "select";
    }
    const hoveredOut =
      this.selecting || this.state === "writing" ? null : this.toolbarOpen ? this.hovered : null;
    let state: WriteState;
    if (this.state === "idle") state = "idle";
    else if (this.erasing) state = "erasing";
    else if (this.strokeOpen) state = "writing";
    else if (this.selecting) state = "select";
    else if (this.toolbarOpen && !this.armed) state = "select";
    else state = "ready";
    return {
      state,
      toolbarOpen: this.toolbarOpen,
      hovered: hoveredOut,
      dwell,
      cursor,
      cursorMode,
      tool: this.tool,
      effects,
    };
  }
}
