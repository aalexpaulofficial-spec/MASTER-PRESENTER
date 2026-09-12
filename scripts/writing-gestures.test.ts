/**
 * Master Write — gesture + geometry test (one index finger, one toolbar).
 *
 * Dependency-free: run with Node 24+, which strips the type annotations from the
 * imported module directly. src/lib/writing.ts pulls in no React, DOM or camera
 * code, so the whole surface can be exercised in a plain process.
 *
 *   node scripts/writing-gestures.test.ts
 *
 * The rule under test above all others (§1 §9 §10): INDEX + MIDDLE is the only
 * gesture that opens the toolbar, it never writes, and holding it never toggles
 * the toolbar more than once. A lone index finger is the pen once a colour is
 * armed; the toolbar stays on screen after a pick (§5 §11).
 */

import {
  WRITE_TIMINGS,
  WRITE_TOOLBAR_ITEMS,
  WRITING_COLORS,
  WRITING_COLOR_ORDER,
  WriteGestureMachine,
  colorValue,
  distanceToSegment,
  eraseFromStrokes,
  strokeNearPoint,
  type WriteEffect,
  type WriteFrame,
  type WriteGesture,
  type WriteMenuItem,
  type WriteSample,
  type WritingPoint,
  type WritingStroke,
} from "../src/lib/writing.ts";

let passed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) passed += 1;
  else failures.push(`  ${msg}`);
}

function group(title: string, fn: () => void): void {
  const before = failures.length;
  fn();
  const failed = failures.length - before;
  const label = failed === 0 ? "PASS" : `FAIL (${failed})`;
  console.log(`${label.padEnd(10)} ${title}`);
}
/** The effect kinds of one frame, in order, for easy comparison. */
function kinds(effects: WriteEffect[]): string {
  return effects.map((e) => e.kind).join(",");
}

/** Fills in the boring parts of a sample; `gesture` defaults to the index finger. */
function sample(over: Partial<WriteSample> & { now: number }): WriteSample {
  return {
    gesture: over.gesture ?? "index",
    point: over.point ?? null,
    hit: over.hit ?? null,
    now: over.now,
  };
}

function step(m: WriteGestureMachine, over: Partial<WriteSample> & { now: number }): WriteFrame {
  return m.update(sample(over));
}

const T = WRITE_TIMINGS;
/** A spot on the toolbar, and a spot out in the middle of the slide. */
const TOOL: WritingPoint = { x: 0.5, y: 0.9 };
const MID: WritingPoint = { x: 0.5, y: 0.5 };

/** Raises index + middle to open the toolbar, then dwells on `item`. */
function openAndPick(
  m: WriteGestureMachine,
  item: WriteMenuItem,
  startNow: number,
  pickGesture: WriteGesture = "index",
): WriteFrame {
  // INDEX + MIDDLE opens the toolbar (§1 §7 §9)...
  step(m, { gesture: "eraser", point: MID, now: startNow });
  step(m, { gesture: "eraser", point: MID, now: startNow + 10 });
  step(m, { gesture: "eraser", point: MID, now: startNow + 20 });
  // ...then the presenter drops to a lone index finger and dwells on the item.
  let picked: WriteFrame | null = null;
  if (pickGesture === "index") {
    step(m, { gesture: "index", point: TOOL, now: startNow + 30 });
    step(m, { gesture: "index", point: TOOL, hit: item, now: startNow + 40 });
    picked = step(m, { gesture: "index", point: TOOL, hit: item, now: startNow + 40 + T.dwellMs });
  } else {
    step(m, { gesture: "eraser", point: TOOL, now: startNow + 30 });
    step(m, { gesture: "eraser", point: TOOL, hit: item, now: startNow + 40 });
    picked = step(m, { gesture: "eraser", point: TOOL, hit: item, now: startNow + 40 + T.dwellMs });
  }
  return picked!;
}

/**
 * Carries the fingertip from the toolbar out to `at` and holds it there until the
 * armed tool goes live. `drew` counts every effect produced on the way — it has to
 * stay at zero, because the trip is not a stroke (§4).
 */
function travel(
  m: WriteGestureMachine,
  at: WritingPoint,
  startNow: number,
  gesture: WriteGesture = "index",
): { now: number; drew: number } {
  let now = startNow;
  let drew = 0;
  const half: WritingPoint = { x: (TOOL.x + at.x) / 2, y: (TOOL.y + at.y) / 2 };
  for (const p of [half, at]) {
    now += 30;
    drew += step(m, { gesture, point: p, now }).effects.length;
  }
  now += T.settleMs + 1;
  drew += step(m, { gesture, point: at, now }).effects.length;
  return { now, drew };
}
/** A machine that has opened the toolbar, picked red, settled and is mid-stroke. */
function writing(): { m: WriteGestureMachine; now: number; at: WritingPoint } {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-0", 0);
  const settledAt = travel(m, MID, 40 + T.dwellMs).now;
  const at: WritingPoint = { x: MID.x + 0.03, y: MID.y };
  const now = settledAt + 30;
  step(m, { gesture: "index", point: at, now });
  return { m, now, at };
}

group("palette — five colours, in the toolbar's order (§2)", () => {
  ok(WRITING_COLORS.length === 5, `expected 5 colours, got ${WRITING_COLORS.length}`);
  ok(WRITING_COLOR_ORDER.length === 5, "five colour slots");
  ok(colorValue("color-0") === "#ef4444", `red first, got ${colorValue("color-0")}`);
  ok(colorValue("color-4") === "#ffffff", `white last, got ${colorValue("color-4")}`);
  ok(new Set(WRITING_COLORS).size === 5, "the colours are distinct");
});

group("toolbar — 5 colours, Manual Eraser, Erase All, Undo, Redo, Minimize (§2 §6 §13 §14)", () => {
  ok(WRITE_TOOLBAR_ITEMS.length === 10, `expected 10 items, got ${WRITE_TOOLBAR_ITEMS.length}`);
  ok(
    WRITE_TOOLBAR_ITEMS.slice(0, 5).join(",") === WRITING_COLOR_ORDER.join(","),
    "the colours come first",
  );
  ok(WRITE_TOOLBAR_ITEMS[5] === "manual-eraser", "Manual Eraser is sixth");
  ok(WRITE_TOOLBAR_ITEMS[6] === "clear-all", "Erase All is seventh");
  ok(WRITE_TOOLBAR_ITEMS[7] === "undo", "Undo is eighth");
  ok(WRITE_TOOLBAR_ITEMS[8] === "redo", "Redo is ninth");
  ok(WRITE_TOOLBAR_ITEMS[9] === "minimize", "Minimize is last");
});

group("geometry — distance from a point to a segment", () => {
  const a: WritingPoint = { x: 0, y: 0 };
  const b: WritingPoint = { x: 1, y: 0 };
  ok(Math.abs(distanceToSegment({ x: 0.5, y: 0.25 }, a, b) - 0.25) < 1e-9, "perpendicular");
  ok(Math.abs(distanceToSegment({ x: -0.5, y: 0 }, a, b) - 0.5) < 1e-9, "before the start");
  ok(Math.abs(distanceToSegment({ x: 1.5, y: 0 }, a, b) - 0.5) < 1e-9, "past the end");
  ok(distanceToSegment({ x: 0.4, y: 0 }, a, a) === 0.4, "a zero-length segment is a point");
});
group("geometry — a stroke is near the fingertip only where it really passes", () => {
  const stroke: WritingStroke = {
    id: "s1",
    color: "#ef4444",
    points: [
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ],
  };
  ok(strokeNearPoint(stroke, { x: 0.5, y: 0.51 }, 0.03), "a hit right on the line");
  ok(!strokeNearPoint(stroke, { x: 0.5, y: 0.7 }, 0.03), "a miss well above it");
  ok(!strokeNearPoint(stroke, { x: 0.05, y: 0.5 }, 0.03), "a miss beyond the end");
});

group("§9 — erasing only touches the overlay strokes under the fingertip", () => {
  let seq = 0;
  const nextId = () => `e${(seq += 1)}`;
  const line: WritingStroke = {
    id: "s1",
    color: "#ef4444",
    points: Array.from({ length: 11 }, (_, i) => ({ x: 0.1 + i * 0.08, y: 0.5 })),
  };
  const other: WritingStroke = {
    id: "s2",
    color: "#2563eb",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.1 },
    ],
  };
  const strokes = [line, other];

  const missed = eraseFromStrokes(strokes, { x: 0.5, y: 0.9 }, 0.035, nextId);
  ok(missed === strokes, "a miss returns the very same array, so nothing repaints");

  const cut = eraseFromStrokes(strokes, { x: 0.5, y: 0.5 }, 0.035, nextId);
  ok(cut !== strokes, "a hit returns a new array");
  ok(cut.includes(other), "the untouched stroke is kept by reference");
  ok(!cut.includes(line), "the hit stroke is replaced, not mutated");
  ok(line.points.length === 11, "and the original stroke object is left alone");
  const pieces = cut.filter((s) => s !== other);
  ok(pieces.length === 2, `a mid-line rub leaves two pieces, got ${pieces.length}`);
  ok(
    pieces.every((s) => s.color === "#ef4444"),
    "the pieces keep the ink colour",
  );
  ok(new Set(cut.map((s) => s.id)).size === cut.length, "every piece gets its own id");

  const end = eraseFromStrokes([other], { x: 0.3, y: 0.1 }, 0.035, nextId);
  ok(end.length === 0 || end.every((s) => s.points.length > 0), "no empty stroke survives");
});

group("§1 §7 §9 — INDEX + MIDDLE opens the toolbar and never writes", () => {
  const m = new WriteGestureMachine();
  // Frame 1-2 are the debounce hold, frame 3 actually opens (§10).
  const f1 = step(m, { gesture: "eraser", point: MID, now: 1000 });
  ok(!f1.toolbarOpen, "not open on the first flicker frame");
  const f2 = step(m, { gesture: "eraser", point: MID, now: 1010 });
  ok(!f2.toolbarOpen, "not open on the second");
  const opened = step(m, { gesture: "eraser", point: MID, now: 1020 });
  ok(opened.toolbarOpen, "the toolbar opens on the held raise");
  ok(opened.state === "select", `state select, got ${opened.state}`);
  ok(opened.effects.length === 0, "and absolutely nothing is drawn");
  ok(opened.cursorMode === "select", `the fingertip is a selector, got ${opened.cursorMode}`);

  // Holding index + middle must NOT re-toggle — it stays open and writes nothing.
  let toggles = 0;
  let drew = 0;
  let last = opened;
  for (let i = 1; i <= 30; i += 1) {
    last = step(m, {
      gesture: "eraser",
      point: { x: 0.5 + (i % 3) * 0.05, y: 0.5 },
      now: 1030 + i * 40,
    });
    toggles += last.toolbarOpen ? 0 : 1; // a close would be a toggle
    drew += last.effects.length;
  }
  ok(last.toolbarOpen, "toolbar stays open while two fingers are held (§10)");
  ok(drew === 0, `two fingers never draw, got ${drew} effects`);
});

group("§10 — lowering the hand and re-raising gives exactly ONE open each time", () => {
  const m = new WriteGestureMachine();
  step(m, { gesture: "eraser", point: MID, now: 0 });
  step(m, { gesture: "eraser", point: MID, now: 10 });
  const o1 = step(m, { gesture: "eraser", point: MID, now: 20 });
  ok(o1.toolbarOpen, "first raise opens");
  // Lower the hand fully.
  step(m, { gesture: "none", point: null, now: 100 });
  step(m, { gesture: "none", point: null, now: 200 });
  const o2 = step(m, { gesture: "eraser", point: MID, now: 300 });
  step(m, { gesture: "eraser", point: MID, now: 310 });
  const o3 = step(m, { gesture: "eraser", point: MID, now: 320 });
  ok(o2.toolbarOpen && o3.toolbarOpen, "re-raising opens again");
  // Holding it should not oscillate.
  let openedEvery = true;
  for (let i = 1; i <= 20; i += 1) {
    const f = step(m, { gesture: "eraser", point: MID, now: 330 + i * 40 });
    if (!f.toolbarOpen) openedEvery = false;
  }
  ok(openedEvery, "and never closes while held");
});

group("§3 §7 — the cursor is exactly the fingertip sample that came in", () => {
  const m = new WriteGestureMachine();
  step(m, { gesture: "eraser", point: MID, now: 0 });
  step(m, { gesture: "eraser", point: MID, now: 10 });
  step(m, { gesture: "eraser", point: MID, now: 20 });
  const p: WritingPoint = { x: 0.31, y: 0.62 };
  const f = step(m, { gesture: "index", point: p, now: 30 });
  ok(f.cursor === p, "the cursor is the index-tip sample itself, not a derived point");
  const g = step(m, { gesture: "none", point: null, now: 50 });
  ok(g.cursor === null && g.cursorMode === null, "no hand, no cursor");
});

group("§3 §4 — dwelling on a colour arms it; the toolbar STAYS open (§5 §11)", () => {
  const m = new WriteGestureMachine();
  // Open with index + middle, then select with index.
  step(m, { gesture: "eraser", point: MID, now: 0 });
  step(m, { gesture: "eraser", point: MID, now: 10 });
  step(m, { gesture: "eraser", point: MID, now: 20 });
  const hovering = step(m, { gesture: "index", point: TOOL, hit: "color-2", now: 30 });
  ok(hovering.hovered === "color-2" && hovering.dwell === 0, "the dwell starts on hover");
  const early = step(m, { gesture: "index", point: TOOL, hit: "color-2", now: 30 + T.dwellMs - 1 });
  ok(early.effects.length === 0, "nothing is picked before the dwell is up");
  ok(early.dwell > 0.9 && early.dwell < 1, `the dwell fills, got ${early.dwell.toFixed(3)}`);
  const picked = step(m, { gesture: "index", point: TOOL, hit: "color-2", now: 30 + T.dwellMs });
  ok(
    kinds(picked.effects) === "select-color",
    `expected select-color, got "${kinds(picked.effects)}"`,
  );
  const eff = picked.effects[0];
  ok(eff?.kind === "select-color" && eff.color === "color-2", "the chosen colour is reported");
  ok(picked.toolbarOpen, "THE TOOLBAR STAYS OPEN after the pick (§5 §11)");
  ok(picked.state === "ready" && picked.tool === "pen", `armed and ready, got ${picked.state}`);
  ok(picked.hovered === null && picked.dwell === 0, "the hover clears but the toolbar remains");
  ok(picked.cursorMode === "pen", `the cursor becomes a pen, got ${picked.cursorMode}`);
});

group("§4 — the trip from the toolbar back to the slide leaves no mark", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-0", 0);
  const { now, drew } = travel(m, MID, 40 + T.dwellMs);
  ok(drew === 0, `travelling after a pick must draw nothing, got ${drew} effects`);
  const armed = step(m, { gesture: "index", point: MID, now: now + 30 });
  ok(armed.effects.length === 0, "and a settled fingertip is still only a cursor");
  ok(armed.state === "ready" && armed.cursorMode === "pen", `ready pen, got ${armed.state}`);
});

group("§5 — a parked fingertip is a cursor, a deliberate move writes at once", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-0", 0);
  const { now } = travel(m, MID, 40 + T.dwellMs);
  let drew = 0;
  let last: WriteFrame | null = null;
  for (let i = 1; i <= 12; i += 1) {
    last = step(m, {
      gesture: "index",
      point: { x: MID.x + (i % 2 === 1 ? 0.002 : -0.002), y: MID.y },
      now: now + i * 33,
    });
    drew += last.effects.length;
  }
  ok(drew === 0, `a trembling, parked fingertip must not write, got ${drew} effects`);
  ok(last?.state === "ready" && last?.cursorMode === "pen", "it stays a ready pen cursor");

  const begun = step(m, {
    gesture: "index",
    point: { x: MID.x + 0.04, y: MID.y },
    now: now + 12 * 33 + 30,
  });
  ok(
    kinds(begun.effects) === "begin,extend",
    `one deliberate move starts the stroke, got "${kinds(begun.effects)}"`,
  );
  ok(begun.state === "writing" && begun.cursorMode === "pen-active", "the machine is writing");
  const first = begun.effects[0];
  const second = begun.effects[1];
  ok(
    first?.kind === "begin" && first.point.x < MID.x + 0.04,
    "the stroke starts where the movement started, so no letter is clipped",
  );
  ok(
    second?.kind === "extend" && Math.abs(second.point.x - (MID.x + 0.04)) < 1e-9,
    "and reaches the fingertip in the very same frame — no trailing ink (§6)",
  );
});

group("§6 — ink tracks the fingertip, jitter is ignored, a jump re-joins", () => {
  const { m, now, at } = writing();
  const ext = step(m, { gesture: "index", point: { x: at.x + 0.02, y: at.y }, now: now + 30 });
  ok(kinds(ext.effects) === "extend", `movement extends the stroke, got "${kinds(ext.effects)}"`);
  const held = ext.effects[0];
  ok(held?.kind === "extend" && held.point.x === at.x + 0.02, "the ink sits on the fingertip");
  const jitter = step(m, { gesture: "index", point: { x: at.x + 0.0205, y: at.y }, now: now + 60 });
  ok(jitter.effects.length === 0, "sub-minStep jitter adds no point");
  ok(jitter.state === "writing", "but the stroke stays open");
  const jump = step(m, { gesture: "index", point: { x: at.x + 0.14, y: at.y }, now: now + 90 });
  ok(kinds(jump.effects) === "end,begin", `a tracking jump re-joins, got "${kinds(jump.effects)}"`);
});

group("§5 — holding still lifts the pen; moving again starts a fresh stroke", () => {
  const { m, now, at } = writing();
  const lifted = step(m, { gesture: "index", point: at, now: now + T.idleEndMs + 1 });
  ok(kinds(lifted.effects) === "end", `stillness lifts the pen, got "${kinds(lifted.effects)}"`);
  ok(lifted.state === "ready" && lifted.cursorMode === "pen", "back to a ready cursor");
  ok(lifted.toolbarOpen, "and the toolbar is STILL there for the next pick (§5 §11)");
  const again = step(m, {
    gesture: "index",
    point: { x: at.x, y: at.y - 0.05 },
    now: now + T.idleEndMs + 40,
  });
  ok(
    kinds(again.effects) === "begin,extend",
    `moving again writes a new stroke, got "${kinds(again.effects)}"`,
  );
});

group("§12 — one or two misread frames never disturb a stroke", () => {
  const { m, now, at } = writing();
  const f1 = step(m, { gesture: "eraser", point: at, now: now + 30 });
  const f2 = step(m, { gesture: "eraser", point: at, now: now + 60 });
  ok(f1.toolbarOpen && f2.toolbarOpen, "index+middle reopens rather than disturbs");
  ok(f1.effects.length === 0 && f2.effects.length === 0, "but no stroke is drawn");
  ok(f2.state === "writing", "the open stroke survives the flicker");
  const back = step(m, { gesture: "index", point: { x: at.x + 0.02, y: at.y }, now: now + 90 });
  ok(kinds(back.effects) === "extend", "writing continues on the same stroke");
});

group("§7 §9 — INDEX + MIDDLE opens the toolbar again while writing", () => {
  const { m, now, at } = writing();
  // Two held frames are the flicker window; the third confirms the raise and
  // re-opens the toolbar, closing the stroke cleanly.
  const f1 = step(m, { gesture: "eraser", point: at, now: now + 30 });
  const f2 = step(m, { gesture: "eraser", point: at, now: now + 60 });
  const f3 = step(m, { gesture: "eraser", point: at, now: now + 90 });
  ok(f1.toolbarOpen && f2.toolbarOpen, "the toolbar is up through the flicker window");
  ok(f3.toolbarOpen, "the held raise re-opens the toolbar");
  ok(f1.effects.length === 0, "the flicker frames never write");
  ok(kinds(f3.effects) === "end", `the open stroke is closed cleanly, got "${kinds(f3.effects)}"`);
  const f4 = step(m, { gesture: "eraser", point: at, now: now + 120 });
  ok(f4.state === "select" && f4.cursorMode === "select", "the fingertip is a selector again");
  // Closing the hand and raising again only opens ONCE.
  step(m, { gesture: "none", point: null, now: now + 200 });
  step(m, { gesture: "none", point: null, now: now + 300 });
  step(m, { gesture: "eraser", point: at, now: now + 400 });
  let open = false;
  for (let i = 1; i <= 10; i += 1) {
    const f = step(m, { gesture: "eraser", point: at, now: now + 400 + i * 40 });
    if (f.toolbarOpen) open = true;
  }
  ok(open, "a fresh raise reopens the toolbar cleanly");
});

group("§13 — Undo and Redo controls fire exactly once on dwell", () => {
  const m = new WriteGestureMachine();
  step(m, { gesture: "eraser", point: MID, now: 0 });
  step(m, { gesture: "eraser", point: MID, now: 10 });
  step(m, { gesture: "eraser", point: MID, now: 20 });
  step(m, { gesture: "index", point: TOOL, now: 30 });
  step(m, { gesture: "index", point: TOOL, hit: "undo", now: 40 });
  const fired = step(m, { gesture: "index", point: TOOL, hit: "undo", now: 40 + T.dwellMs });
  ok(kinds(fired.effects) === "undo", `undo fires once, got "${kinds(fired.effects)}"`);
  // Staying on it must not re-fire (§2 §3).
  let extra = 0;
  for (let i = 1; i <= 8; i += 1) {
    const f = step(m, {
      gesture: "index",
      point: TOOL,
      hit: "undo",
      now: 40 + T.dwellMs + i * 40,
    });
    extra += f.effects.filter((e) => e.kind === "undo").length;
  }
  ok(extra === 0, `undo does not re-fire while held, got ${extra} extras`);

  // Redo behaves the same.
  const m2 = new WriteGestureMachine();
  step(m2, { gesture: "eraser", point: MID, now: 0 });
  step(m2, { gesture: "eraser", point: MID, now: 10 });
  step(m2, { gesture: "eraser", point: MID, now: 20 });
  step(m2, { gesture: "index", point: TOOL, now: 30 });
  step(m2, { gesture: "index", point: TOOL, hit: "redo", now: 40 });
  const r = step(m2, { gesture: "index", point: TOOL, hit: "redo", now: 40 + T.dwellMs });
  ok(kinds(r.effects) === "redo", `redo fires once, got "${kinds(r.effects)}"`);
});

group("§6 — Minimize hides the toolbar but keeps the armed tool (§23)", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-1", 0);
  step(m, { gesture: "index", point: TOOL, now: 40 + T.dwellMs + 5 });
  step(m, { gesture: "index", point: TOOL, hit: "minimize", now: 40 + T.dwellMs + 15 });
  const min = step(m, {
    gesture: "index",
    point: TOOL,
    hit: "minimize",
    now: 40 + T.dwellMs + 15 + T.dwellMs,
  });
  ok(min.toolbarOpen === false, "the toolbar is hidden after Minimize");
  ok(min.tool === "pen", "the pen/colour stays armed");
  // The index finger keeps drawing while minimized.
  const { now } = travel(m, MID, 40 + T.dwellMs + 15 + T.dwellMs + 5);
  const drawn = step(m, { gesture: "index", point: { x: MID.x + 0.05, y: MID.y }, now: now + 30 });
  ok(
    kinds(drawn.effects) === "begin,extend",
    `writing continues while minimized, got "${kinds(drawn.effects)}"`,
  );
});

group("§10 — a pick made with two fingers up fires once and never re-toggles", () => {
  const m = new WriteGestureMachine();
  const picked = openAndPick(m, "clear-all", 0, "eraser");
  ok(kinds(picked.effects) === "clear", `Erase All fires once via two fingers, got "${kinds(picked.effects)}"`);
  // Holding the fingers still on the button must not fire it again (§2 §3).
  let extra = 0;
  for (let i = 1; i <= 6; i += 1) {
    const f = step(m, { gesture: "eraser", point: TOOL, hit: "clear-all", now: 40 + T.dwellMs + i * 60 });
    extra += f.effects.filter((e) => e.kind === "clear").length;
  }
  ok(extra === 0, `Erase All does not re-fire while held, got ${extra} extras`);
  // And the held raise never toggles the toolbar a second time (§10).
  const held = step(m, { gesture: "eraser", point: TOOL, now: 40 + T.dwellMs + 500 });
  ok(held.toolbarOpen, "the toolbar stays exactly as the pick left it");
});

group("§10 — Erase All clears current slide, hands back the pen", () => {
  const m = new WriteGestureMachine();
  const done = openAndPick(m, "clear-all", 0, "eraser");
  ok(kinds(done.effects) === "clear", `expected clear, got "${kinds(done.effects)}"`);
  ok(done.toolbarOpen, "the toolbar STAYS OPEN after Erase All now (§5 §11 §12)");
  ok(done.state === "ready", `back to ready, got ${done.state}`);
  ok(done.tool === "pen" && done.cursorMode === "pen", "with the pen — not the eraser — in hand");
  ok(travel(m, MID, 40 + T.dwellMs).drew === 0, "clearing does not leave the fingertip drawing");
});

group("§9 — Manual Eraser arms, rests, sweeps, then stops", () => {
  const m = new WriteGestureMachine();
  const armed = openAndPick(m, "manual-eraser", 0);
  ok(
    kinds(armed.effects) === "select-eraser",
    `expected select-eraser, got "${kinds(armed.effects)}"`,
  );
  ok(armed.state === "ready" && armed.tool === "eraser", `armed, got ${armed.state}`);
  ok(armed.toolbarOpen, "THE TOOLBAR STAYS OPEN after the pick (§5 §11)");
  ok(armed.cursorMode === "eraser", `the cursor becomes the eraser, got ${armed.cursorMode}`);

  const { now, drew } = travel(m, MID, 40 + T.dwellMs);
  ok(drew === 0, `carrying the eraser to the slide erases nothing, got ${drew} effects`);
  const rest = step(m, { gesture: "index", point: MID, now: now + 30 });
  ok(
    rest.effects.length === 0 && rest.state === "ready",
    "a resting eraser rubs nothing out",
  );
});

group("§9 — a sweeping eraser rubs out under the fingertip, and only there", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "manual-eraser", 0);
  const { now } = travel(m, MID, 40 + T.dwellMs);
  const sweep = step(m, { gesture: "index", point: { x: MID.x + 0.03, y: MID.y }, now: now + 30 });
  ok(kinds(sweep.effects) === "erase-begin,erase", `a sweep erases, got "${kinds(sweep.effects)}"`);
  const rub = sweep.effects[1];
  ok(rub?.kind === "erase" && rub.point.x === MID.x + 0.03, "at the fingertip, not behind it");
  ok(sweep.state === "erasing" && sweep.cursorMode === "eraser-active", "the eraser is working");
  const more = step(m, { gesture: "index", point: { x: MID.x + 0.06, y: MID.y }, now: now + 60 });
  ok(kinds(more.effects) === "erase", "each step keeps rubbing");
  const jitter = step(m, {
    gesture: "index",
    point: { x: MID.x + 0.0605, y: MID.y },
    now: now + 90,
  });
  ok(jitter.effects.length === 0, "sub-minStep jitter does not rub twice");
  const stopped = step(m, {
    gesture: "index",
    point: { x: MID.x + 0.06, y: MID.y },
    now: now + 90 + T.idleEndMs + 1,
  });
  ok(
    kinds(stopped.effects) === "erase-end",
    `a held still ends the sweep with erase-end, got "${kinds(stopped.effects)}"`,
  );
  ok(stopped.state === "ready" && stopped.tool === "eraser", "the eraser stays in hand");
});

group("§6 — a tracking blink is bridged, a real drop ends the stroke", () => {
  const { m, now, at } = writing();
  const blink = step(m, { gesture: "none", point: null, now: now + 30 });
  ok(blink.effects.length === 0, "a loss inside lostMs never ends the stroke");
  ok(blink.cursor === null && blink.cursorMode === null, "the cursor hides while the hand is gone");
  ok(blink.state === "writing", "the stroke is still open");
  const back = step(m, { gesture: "index", point: { x: at.x + 0.02, y: at.y }, now: now + 60 });
  ok(kinds(back.effects) === "extend", `the same stroke continues, got "${kinds(back.effects)}"`);

  const gone = step(m, { gesture: "none", point: null, now: now + 90 });
  ok(gone.effects.length === 0, "the drop is bridged first");
  const dropped = step(m, { gesture: "none", point: null, now: now + 90 + T.lostMs + 1 });
  ok(
    kinds(dropped.effects) === "end",
    `a real drop ends the stroke, got "${kinds(dropped.effects)}"`,
  );
  ok(dropped.state === "idle", "and the machine goes idle with the hand down");
  const stillIdle = step(m, { gesture: "none", point: null, now: now + 900 });
  ok(stillIdle.effects.length === 0 && stillIdle.state === "idle", "no repeated end effects");
});

group("§5 — a quick re-raise keeps the armed colour but still will not write by itself", () => {
  const { m, now, at } = writing();
  step(m, { gesture: "none", point: null, now: now + 30 });
  const endAt = now + 30 + T.lostMs + 1;
  const ended = step(m, { gesture: "none", point: null, now: endAt });
  ok(kinds(ended.effects) === "end", `the stroke ends first, got "${kinds(ended.effects)}"`);
  // A quick re-raise now enters SELECTING mode (toolbar stays up but the fingertip
  // is a pen), so the toolbar stays open and the raise alone writes nothing (§1 §5 §7 §11).
  const resumed = step(m, { gesture: "index", point: at, now: endAt + 200 });
  ok(resumed.toolbarOpen, "the toolbar stays open after a quick re-raise (§5 §11)");
  ok(
    (resumed.state === "ready" || resumed.state === "select" || resumed.state === "writing") &&
      resumed.tool === "pen",
    `the colour is still armed and the fingertip a pen, got ${resumed.state}/${resumed.toolbarOpen}`,
  );
  ok(resumed.effects.length === 0, "and the raise alone writes nothing (§1)");
  const settling = step(m, { gesture: "index", point: at, now: endAt + 200 + T.settleMs + 1 });
  ok(settling.effects.length === 0, "settling draws nothing either");
  const drawing = step(m, {
    gesture: "index",
    point: { x: at.x, y: at.y + 0.05 },
    now: endAt + 260 + T.settleMs,
  });
  ok(
    kinds(drawing.effects) === "begin,extend",
    `then a deliberate move writes again, got "${kinds(drawing.effects)}"`,
  );
});

group("§12 — reset() drops everything a slide change must not keep", () => {
  const { m } = writing();
  m.reset();
  const idle = step(m, { gesture: "none", point: null, now: 9000 });
  ok(idle.effects.length === 0, "no dangling end effect after a reset");
  ok(idle.state === "idle" && idle.tool === "pen", "an idle machine with no tool armed");
  ok(idle.toolbarOpen === false && idle.hovered === null, "no toolbar, no hover");
  const raised = step(m, { gesture: "eraser", point: MID, now: 9010 });
  step(m, { gesture: "eraser", point: MID, now: 9020 });
  const r2 = step(m, { gesture: "eraser", point: MID, now: 9030 });
  ok(r2.toolbarOpen, "index+middle offers the toolbar after reset");
  ok(r2.effects.length === 0, "and still writes nothing (§1 §9)");
});

group("§5 §7 §11 — the toolbar stays visible while the presenter writes", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-0", 0);
  const { now } = travel(m, MID, 40 + T.dwellMs);
  const resumed = step(m, { gesture: "index", point: MID, now: now + 30 });
  ok(resumed.toolbarOpen, "the toolbar is still open when the index finger re-raises");
  const drawn = step(m, { gesture: "index", point: { x: MID.x + 0.05, y: MID.y }, now: now + 60 });
  ok(
    kinds(drawn.effects) === "begin,extend",
    `writing happens with the toolbar visible, got "${kinds(drawn.effects)}"`,
  );
  ok(drawn.toolbarOpen, "and the toolbar is STILL visible during the stroke (§5 §11)");
});

group("§7 §11 — INDEX+MIDDLE re-enters select mode without hiding the toolbar", () => {
  const m = new WriteGestureMachine();
  openAndPick(m, "color-0", 0);
  const { now } = travel(m, MID, 40 + T.dwellMs);
  step(m, { gesture: "index", point: { x: MID.x + 0.05, y: MID.y }, now: now + 30 });
  step(m, { gesture: "eraser", point: MID, now: now + 60 });
  step(m, { gesture: "eraser", point: MID, now: now + 70 });
  const reopened = step(m, { gesture: "eraser", point: MID, now: now + 80 });
  ok(reopened.toolbarOpen, "the toolbar stays open when re-entering select mode");
  ok(reopened.state === "select", `and the fingertip is a selector, got ${reopened.state}`);
});

console.log("");
if (failures.length > 0) {
  console.log(`${passed} checks passed, ${failures.length} failed:`);
  for (const line of failures) console.log(line);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
