import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Hand,
  HelpCircle,
  Maximize,
  Minus,
  Send,
  UploadCloud,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { DeckStage } from "@/components/presenter/DeckStage";
import { CameraWindow } from "@/components/presenter/CameraWindow";
import { WritingLayer, type WriteTick } from "@/components/presenter/WritingLayer";
import { useHandTracking, type IndexFingerPoint } from "@/hooks/useHandTracking";
import { useVoiceControl, VoiceHighlight } from "@/hooks/useVoiceControl";
import { usePresentationSession } from "@/hooks/usePresentationSession";
import { useLightningAI } from "@/hooks/useLightningAI";
import {
  ERASER_RADIUS,
  eraseFromStrokes,
  type WritingColor,
  type WritingPoint,
  type WritingStroke,
} from "@/lib/writing";
import { Mic, MicOff, Sparkles } from "lucide-react";

export const Route = createFileRoute("/present")({
  head: () => ({
    meta: [
      { title: "Present with your hands — Master Presenter" },
      {
        name: "description",
        content:
          "Upload your presentation and control slides with simple hand gestures. Front palm for next, back palm for previous, index finger for a laser pointer.",
      },
      { property: "og:title", content: "Present with your hands — Master Presenter" },
      {
        property: "og:description",
        content:
          "Upload a presentation and control it with hand gestures, straight from your browser.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { pro?: boolean; plan?: string } => {
    const out: { pro?: boolean; plan?: string } = {
      pro: search["pro"] === true || search["pro"] === "true",
    };
    if (typeof search["plan"] === "string") out.plan = search["plan"];
    return out;
  },
  component: PresentPage,
});

type Phase = "upload" | "uploading" | "analyzing" | "preview" | "ready" | "failed";

const phaseCopy: Record<Exclude<Phase, "upload" | "ready" | "failed">, string> = {
  uploading: "Uploading file",
  analyzing: "Analyzing presentation",
  preview: "Generating preview",
};

function formatPlanBadge(plan?: string | null): string {
  if (!plan) return "MASTER HAND";
  const p = plan.trim().toLowerCase();
  if (p === "master voice" || p === "master_voice" || p === "mastervoice" || p === "voice") {
    return "MASTER VOICE";
  }
  if (p === "master write" || p === "master_write" || p === "masterwrite" || p === "write") {
    return "MASTER WRITE";
  }
  if (p === "master ai" || p === "master_ai" || p === "masterai" || p === "ai") {
    return "MASTER AI";
  }
  if (p.includes("voice")) return "MASTER VOICE";
  if (p.includes("write")) return "MASTER WRITE";
  if (p.includes("ai")) return "MASTER AI";
  if (p.includes("business")) return "BUSINESS";
  if (p.includes("hand") || p === "free") return "MASTER HAND";
  if (p === "pro") return "MASTER VOICE";
  return plan.toUpperCase();
}

function getStoredPlan(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("master_presenter_selected_plan");
  } catch {
    return null;
  }
}

function setStoredPlan(plan: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("master_presenter_selected_plan", plan);
  } catch {
    // ignore
  }
}

function capabilitiesForPlan(plan: string) {
  const normalized = formatPlanBadge(plan);
  const isAI = normalized === "MASTER AI";
  const isWrite = normalized === "MASTER WRITE";
  return {
    hands: true,
    voice: normalized !== "MASTER HAND",
    // Laser works in all plans EXCEPT Master Write (writing takes over index finger)
    laser: !isWrite && !isAI,
    // Master Write AND Master AI both enable the writing overlay
    writing: isWrite || isAI,
    ai: isAI,
  };
}

function PresentPage() {
  usePresentationSession();
  const [phase, setPhase] = useState<Phase>("upload");
  const [progress, setProgress] = useState(0);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [slideCount, setSlideCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const search = Route.useSearch();
  const [planName, setPlanName] = useState<string>(() => {
    if (search.plan) return formatPlanBadge(search.plan);
    const stored = getStoredPlan();
    if (stored) return formatPlanBadge(stored);
    if (search.pro) return "MASTER VOICE";
    return "MASTER HAND";
  });
  const [isPro, setIsPro] = useState<boolean>(() => {
    const initial = search.plan
      ? formatPlanBadge(search.plan)
      : getStoredPlan()
        ? formatPlanBadge(getStoredPlan())
        : search.pro
          ? "MASTER VOICE"
          : "MASTER HAND";
    return initial !== "MASTER HAND";
  });

  useEffect(() => {
    if (search.plan) {
      const formatted = formatPlanBadge(search.plan);
      setPlanName(formatted);
      setIsPro(formatted !== "MASTER HAND");
      setStoredPlan(formatted);
    } else if (search.pro && !getStoredPlan()) {
      setPlanName("MASTER VOICE");
      setIsPro(true);
      setStoredPlan("MASTER VOICE");
    }
  }, [search.plan, search.pro]);

  const [metadata, setMetadata] = useState<any[] | null>(null);
  const [highlights, setHighlights] = useState<VoiceHighlight[]>([]);
  const [writingBySlide, setWritingBySlide] = useState<Record<number, WritingStroke[]>>({});
  const [activeWritingColor, setActiveWritingColor] = useState<WritingColor>("color-0");
  // Per-slide undo/redo stacks (§13 §14 §29). Only Master Write overlay strokes
  // live here; the original PPT/PPTX is never touched (§14 §21 §28).
  const historyRef = useRef<Record<number, { undo: WritingStroke[][]; redo: WritingStroke[][] }>>(
    {},
  );
  const capabilities = capabilitiesForPlan(planName);

  // ── LIGHTNING AI ────────────────────────────────────────────────────────────
  const { messages: aiMessages, status: aiStatus, ask: askLightningAI } = useLightningAI(
    metadata,
    index,
    setIndex,
  );
  const [aiInput, setAiInput] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const aiInputRef = useRef<HTMLInputElement | null>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll AI message list when a new message arrives
  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiMessages]);

  const submitAIQuestion = useCallback(
    (q?: string) => {
      const question = (q ?? aiInput).trim();
      if (!question) return;
      setAiInput("");
      setAiOpen(true);
      askLightningAI(question);
    },
    [aiInput, askLightningAI],
  );

  const handleVoiceLightningAI = useCallback(
    (question: string) => {
      setAiOpen(true);
      askLightningAI(question);
    },
    [askLightningAI],
  );

  const slideCountRef = useRef(slideCount);
  slideCountRef.current = slideCount;

  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  // WritingLayer fills this so the camera loop can push fingertip samples into it.
  const writeTickRef = useRef<WriteTick | null>(null);
  const toggleToolbarRef = useRef<(() => void) | null>(null);
  const eraseIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<File | null>(null);

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const total = slideCountRef.current || slideCount;
        const max = Math.max(0, total - 1);
        return Math.min(max, Math.max(0, i + delta));
      });
    },
    [slideCount],
  );

  const onAction = useCallback((action: "next" | "prev") => go(action === "next" ? 1 : -1), [go]);

  // A snapshot of the current slide's overlay, paired with the slide it belongs
  // to, so each commit to history is self-contained and slide-aware (§13 §29).
  const snapshot = useCallback(
    (strokes: WritingStroke[]): WritingStroke[] =>
      strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
    [],
  );

  const clearWriting = useCallback(() => {
    setWritingBySlide((prev) => {
      const strokes = prev[index] ?? [];
      if (strokes.length === 0) return prev;
      const hist = historyRef.current;
      const slide = (hist[index] ??= { undo: [], redo: [] });
      slide.undo.push(snapshot(strokes));
      slide.redo = [];
      return { ...prev, [index]: [] };
    });
  }, [index, snapshot]);

  const commitStroke = useCallback(
    (stroke: WritingStroke) => {
      setWritingBySlide((prev) => {
        const before = prev[index] ?? [];
        const hist = historyRef.current;
        const slide = (hist[index] ??= { undo: [], redo: [] });
        slide.undo.push(snapshot(before));
        slide.redo = [];
        return { ...prev, [index]: [...before, stroke] };
      });
    },
    [index, snapshot],
  );

  const eraseAt = useCallback(
    (point: WritingPoint) => {
      setWritingBySlide((prev) => {
        const strokes = prev[index] ?? [];
        const next = eraseFromStrokes(strokes, point, ERASER_RADIUS, () => {
          eraseIdRef.current += 1;
          return `e${eraseIdRef.current}`;
        });
        if (next === strokes) return prev;
        return { ...prev, [index]: next };
      });
    },
    [index],
  );

  // A whole Manual Eraser sweep is bracketed by erase-begin / erase-end so it is one undo entry (§9 §13).
  const eraseSegment = useCallback(
    (beforeSnapshot: WritingStroke[]) => {
      const hist = historyRef.current;
      const entry = (hist[index] ??= { undo: [], redo: [] });
      entry.undo.push(snapshot(beforeSnapshot));
      entry.redo = [];
    },
    [index, snapshot],
  );

  const selectWritingColor = useCallback((color: WritingColor) => {
    setActiveWritingColor(color);
  }, []);

  const undoWriting = useCallback(() => {
    setWritingBySlide((prev) => {
      const hist = historyRef.current;
      const slide = hist[index];
      if (!slide || slide.undo.length === 0) return prev;
      const current = prev[index] ?? [];
      slide.redo.push(snapshot(current));
      const restored = slide.undo.pop() ?? [];
      return { ...prev, [index]: restored };
    });
  }, [index, snapshot]);

  const redoWriting = useCallback(() => {
    setWritingBySlide((prev) => {
      const hist = historyRef.current;
      const slide = hist[index];
      if (!slide || slide.redo.length === 0) return prev;
      const current = prev[index] ?? [];
      slide.undo.push(snapshot(current));
      const restored = slide.redo.pop() ?? [];
      return { ...prev, [index]: restored };
    });
  }, [index, snapshot]);

  // A new slide resets nothing on the slide itself, but the gesture machine is
  // reset in WritingLayer. The per-slide undo/redo stacks persist (§29) until the
  // deck is reloaded.
  const onSlideChangeReset = useCallback(() => {
    setWritingBySlide((prev) => prev);
  }, []);

  // The camera loop feeds fingertip samples straight into the WritingLayer,
  // which owns the palette, gesture machine and canvas. The index finger never
  // reaches the laser in Master Write (§12); index + middle drives the eraser.
  const handleIndexPoint = useCallback(
    (point: IndexFingerPoint | null) => {
      if (!capabilities.writing) return;
      writeTickRef.current?.(point ? { point: point.slide, gesture: point.mode } : null);
    },
    [capabilities.writing],
  );

  const [slideAspect, setSlideAspect] = useState<number>(16 / 9);

  const { videoRef, status, error, gesture, handVisible, retry } = useHandTracking({
    enabled: phase === "preview" || phase === "ready",
    onAction,
    onPointer: setPointer,
    pointerMode: capabilities.writing ? "writing" : "laser",
    onIndexPoint: handleIndexPoint,
    slideAspect,
  });

  // If the camera drops out mid-stroke, close any open writing cleanly.
  useEffect(() => {
    if (capabilities.writing && status !== "live") writeTickRef.current?.(null);
  }, [capabilities.writing, status]);

  const handleFile = useCallback(async (file: File) => {
    const ok = /\.pptx?$/i.test(file.name);
    if (!ok) {
      setFailure("Please choose a .ppt or .pptx presentation.");
      setPhase("failed");
      return;
    }
    fileRef.current = file;
    setFileName(file.name);
    setFailure(null);
    setIndex(0);
    setSlideCount(0);
    setMetadata(null);
    setHighlights([]);
    setWritingBySlide({});
    setPhase("uploading");
    setProgress(12);
    const buf = await file.arrayBuffer();
    setProgress(45);
    setPhase("analyzing");

    await new Promise((r) => setTimeout(r, 220));

    setProgress(72);
    setPhase("preview");
    setBuffer(buf);
  }, []);

  const onReady = useCallback(
    ({
      slideCount: count,
      width,
      height,
    }: {
      slideCount: number;
      width?: number;
      height?: number;
    }) => {
      setSlideCount(count);
      if (width && height && height > 0) {
        setSlideAspect(width / height);
      }
      setProgress(100);
      setPhase("ready");
    },
    [],
  );

  const onDeckError = useCallback((message: string) => {
    setFailure(message);
    setPhase("failed");
  }, []);

  // Fullscreen shows only the slide.
  const toggleFullscreen = useCallback(async () => {
    const el = stageWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    } else {
      await el.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  // Minimize / reopen the Master Write toolbar from the control bar below the
  // slide (works in preview; in fullscreen the toolbar is gesture-driven only).
  // Minimize hides the bar but keeps the armed tool + colour; reopen re-enters
  // select mode (§6 §7 §11). Mirrors the on-screen Minus button.
  const toggleFullFromWriting = useCallback(() => {
    toggleToolbarRef.current?.();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Extract uploaded deck's text boxes in the browser so voice highlighting
  // and LIGHTNING AI target the real slide content. The file is never modified.
  useEffect(() => {
    if ((!capabilities.voice && !capabilities.ai) || !buffer || metadata !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const { extractSlideText } = await import("@/lib/pptx-text");
        const slides = await extractSlideText(buffer);
        if (!cancelled) setMetadata(slides);
      } catch {
        if (!cancelled) setMetadata([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilities.voice, capabilities.ai, buffer, metadata]);

  const handleHighlight = useCallback(
    (text: string, color: string) => {
      const needle = text.toLowerCase().trim();
      if (!needle) return;

      // 1. Search extracted metadata for current slide
      const slide = metadata?.[index];
      const elements: any[] = slide?.text_elements || [];
      const match =
        elements.find((e) => e.text.toLowerCase().includes(needle)) ??
        elements.find((e) =>
          needle.split(" ").some((word) => word.length > 2 && e.text.toLowerCase().includes(word)),
        );

      if (match) {
        setHighlights((prev) => {
          const filtered = prev.filter(
            (h) => !h.text.toLowerCase().includes(needle) && !needle.includes(h.text.toLowerCase()),
          );
          return [
            ...filtered,
            {
              id: Math.random().toString(36).slice(2),
              text: match.text,
              color,
              box: { left: match.left, top: match.top, width: match.width, height: match.height },
            },
          ];
        });
        return;
      }

      // 2. Fallback: Search rendered DOM inside slide stage container
      const stage = stageWrapRef.current?.querySelector(".deck-stage") as HTMLElement | null;
      if (stage) {
        const stageRect = stage.getBoundingClientRect();
        if (stageRect.width > 0 && stageRect.height > 0) {
          const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          let matchedEl: HTMLElement | SVGElement | null = null;
          while ((node = walker.nextNode())) {
            const val = node.nodeValue?.toLowerCase().trim() || "";
            if (val.includes(needle) || (needle.length > 3 && val.includes(needle.slice(0, 4)))) {
              const parent = node.parentElement;
              if (parent && parent !== stage) {
                matchedEl = parent;
                break;
              }
            }
          }

          if (matchedEl) {
            const elRect = matchedEl.getBoundingClientRect();
            const left = Math.max(0, (elRect.left - stageRect.left) / stageRect.width);
            const top = Math.max(0, (elRect.top - stageRect.top) / stageRect.height);
            const width = Math.min(1 - left, elRect.width / stageRect.width);
            const height = Math.min(1 - top, elRect.height / stageRect.height);

            if (width > 0 && height > 0) {
              setHighlights((prev) => {
                const filtered = prev.filter(
                  (h) =>
                    !h.text.toLowerCase().includes(needle) &&
                    !needle.includes(h.text.toLowerCase()),
                );
                return [
                  ...filtered,
                  {
                    id: Math.random().toString(36).slice(2),
                    text: matchedEl!.textContent?.trim() || needle,
                    color,
                    box: { left, top, width, height },
                  },
                ];
              });
              return;
            }
          }
        }
      }

      // If text does not exist on current slide: DO NOTHING (no fake highlight)
    },
    [metadata, index],
  );

  const handleRemoveHighlight = useCallback((text: string) => {
    const needle = text.toLowerCase().trim();
    if (!needle) return;
    setHighlights((prev) =>
      prev.filter(
        (h) => !h.text.toLowerCase().includes(needle) && !needle.includes(h.text.toLowerCase()),
      ),
    );
  }, []);

  const handleClearHighlights = useCallback(() => {
    setHighlights([]);
  }, []);

  const handleGoToSlideByText = useCallback(
    (text: string) => {
      if (!metadata) return false;
      const lowerText = text.toLowerCase();

      const matchingSlideIndex = metadata.findIndex((slide: any) => {
        if (slide.title && slide.title.toLowerCase().includes(lowerText)) return true;
        if (slide.text_elements) {
          return slide.text_elements.some((el: any) => el.text.toLowerCase().includes(lowerText));
        }
        return false;
      });

      if (matchingSlideIndex !== -1) {
        setIndex(matchingSlideIndex);
        return true;
      }
      // No slide carries that text: report the miss instead of claiming success.
      return false;
    },
    [metadata],
  );

  const {
    micState,
    status: voiceStatus,
    supported,
  } = useVoiceControl({
    enabled: capabilities.voice && (phase === "preview" || phase === "ready"),
    extendedCommands: true,
    onNext: () => go(1),
    onPrev: () => go(-1),
    onGoToSlide: (slide: number) => {
      // The uploaded deck is the only source of truth for the slide count, and
      // it is not known until DeckStage reports it. Until then, and for any
      // number past the last slide, do nothing at all.
      const total = slideCountRef.current || slideCount;
      if (total <= 0) return false;
      const max = total - 1;
      if (slide < 0 || slide > max) return false;
      setIndex(slide);
      return true;
    },
    onHighlight: handleHighlight,
    onRemoveHighlight: handleRemoveHighlight,
    onClearHighlights: handleClearHighlights,
    onGoToSlideByText: handleGoToSlideByText,
    onLightningAI: capabilities.ai ? handleVoiceLightningAI : undefined,
  });

  // Compact status label — the colour itself is micState. The microphone
  // starts automatically after permission; there is no manual mic toggle.
  let statusLabel = "Voice unavailable";
  if (supported) {
    switch (voiceStatus) {
      case "starting":
        statusLabel = "Voice starting…";
        break;
      case "listening":
        statusLabel = "Listening";
        break;
      case "executed":
        statusLabel = "Command executed";
        break;
      case "slide_not_found":
        statusLabel = "Slide not found";
        break;
      case "permission_denied":
        statusLabel = "Mic permission denied";
        break;
      case "error":
        statusLabel = "Voice error — retrying…";
        break;
      case "off":
        statusLabel = "Voice starting…";
        break;
      default:
        statusLabel = "Listening";
    }
  }

  // Clear highlights when slide changes
  useEffect(() => {
    setHighlights([]);
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const loading = phase === "uploading" || phase === "analyzing" || phase === "preview";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {!isFullscreen && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <div className="flex items-center gap-1">
            <Link
              to="/"
              aria-label="Back to home"
              className="grid h-8 w-8 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Link to="/" className="flex items-center gap-2 transition-opacity hover:opacity-90">
              <img
                src="/logo.png"
                alt="Master Presenter"
                className="h-7 sm:h-8 w-auto object-contain"
              />
            </Link>
            <span
              className={`ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                isPro
                  ? "bg-primary/20 text-primary"
                  : "bg-secondary text-muted-foreground border border-border"
              }`}
            >
              {planName.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="max-w-[30vw] truncate text-xs text-muted-foreground">{fileName}</span>
            {!isPro && phase === "upload" && (
              <Button asChild size="sm" variant="outline">
                <Link to="/" hash="pricing">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Get Free Premium Master Plans —
                  Unlimited
                </Link>
              </Button>
            )}
          </div>
        </header>
      )}

      {phase === "upload" || phase === "failed" ? (
        <main className="flex flex-1 items-center justify-center px-4 py-16">
          <div className="w-full max-w-xl text-center">
            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Upload your presentation
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
              Your slides stay exactly as you designed them. Nothing is redesigned, replaced or
              reformatted.
            </p>
            <label
              className="mt-8 flex cursor-pointer flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-border bg-card px-6 py-14 transition-colors hover:border-primary/60 hover:bg-primary-soft/40"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void handleFile(f);
              }}
            >
              <UploadCloud className="h-9 w-9 text-primary" />
              <span className="font-display text-base font-semibold">
                Choose a .ppt or .pptx file
              </span>
              <span className="text-xs text-muted-foreground">or drag and drop it here</span>
              <input
                ref={inputRef}
                type="file"
                accept=".ppt,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </label>
            {failure && <p className="mt-5 text-sm text-destructive">{failure}</p>}
          </div>
        </main>
      ) : (
        <main className="flex flex-1 flex-col">
          <div
            ref={stageWrapRef}
            className="relative flex-1 bg-[oklch(0.16_0.015_158)] [&:fullscreen]:h-screen [&:fullscreen]:w-screen"
          >
            {buffer && (
              <DeckStage
                buffer={buffer}
                index={index}
                pointer={capabilities.laser ? pointer : null}
                overlay={
                  capabilities.writing ? (
                    <WritingLayer
                      strokes={writingBySlide[index] ?? []}
                      slideIndex={index}
                      color={activeWritingColor}
                      tickRef={writeTickRef}
                      onSelectColor={selectWritingColor}
                      onClearAll={clearWriting}
                      onCommitStroke={commitStroke}
                      onErase={eraseAt}
                      onEraseSegment={eraseSegment}
                      onUndo={undoWriting}
                      onRedo={redoWriting}
                      toggleToolbarRef={toggleToolbarRef}
                    />
                  ) : undefined
                }
                highlights={highlights}
                onReady={onReady}
                onError={onDeckError}
              />
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center bg-background/95">
                <div className="w-full max-w-sm px-6 text-center">
                  <p className="font-display text-lg font-semibold">
                    {phaseCopy[phase as keyof typeof phaseCopy]}
                  </p>
                  <Progress value={progress} className="mt-4" />
                  <p className="mt-3 truncate text-xs text-muted-foreground">{fileName}</p>
                </div>
              </div>
            )}
          </div>

          {!isFullscreen && (
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border px-4 py-3 sm:gap-3">
              <Button variant="secondary" onClick={() => go(-1)} disabled={index === 0}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
              <Button variant="secondary" onClick={() => go(1)} disabled={index >= slideCount - 1}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
              <Button onClick={() => void toggleFullscreen()}>
                <Maximize className="mr-1 h-4 w-4" /> Enter Fullscreen
              </Button>
              {capabilities.writing && (
                <Button variant="outline" onClick={() => toggleFullFromWriting()}>
                  <Minus className="mr-1 h-4 w-4" /> Open / Hide Toolbar
                </Button>
              )}
              <HowToControl planName={planName} />
              {capabilities.voice && (
                <div className="flex items-center gap-2 ml-2">
                  {!supported ? (
                    <div className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border border-destructive/50 bg-destructive/10 text-destructive">
                      <MicOff className="h-3.5 w-3.5" />
                      Voice not supported in this browser
                    </div>
                  ) : (
                    <div
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
                        micState === "green"
                          ? "border-green-500/60 bg-green-500/10 text-green-600"
                          : micState === "yellow"
                            ? "border-amber-500/60 bg-amber-500/10 text-amber-600"
                            : "border-destructive/50 bg-destructive/10 text-destructive"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full transition-colors ${
                          micState === "green"
                            ? "bg-green-500"
                            : micState === "yellow"
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                      />
                      {statusLabel}
                    </div>
                  )}
                </div>
              )}
              {/* LIGHTNING AI button — Master AI plan only */}
              {capabilities.ai && (
                <Button
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/5 text-amber-600 hover:bg-amber-500/10"
                  onClick={() => setAiOpen((v) => !v)}
                >
                  <Zap className="mr-1 h-4 w-4" /> Lightning AI
                </Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {slideCount ? `${index + 1} / ${slideCount}` : ""}
              </span>
            </div>
          )}

          {/* ── LIGHTNING AI PANEL ────────────────────────────────────────── */}
          {capabilities.ai && aiOpen && !isFullscreen && (
            <div className="border-t border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <div className="mx-auto max-w-2xl">
                {/* Header */}
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-500">
                    <Zap className="h-3.5 w-3.5" /> LIGHTNING AI
                    {aiStatus === "loading" && (
                      <span className="ml-1 animate-pulse text-amber-400">Thinking…</span>
                    )}
                  </span>
                  <button
                    onClick={() => setAiOpen(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>

                {/* Message thread */}
                {aiMessages.length > 0 && (
                  <div className="mb-3 max-h-44 overflow-y-auto rounded-xl border border-amber-500/15 bg-background/60 p-3 space-y-2">
                    {aiMessages.map((msg) => (
                      <div key={msg.id} className={`text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }`}>
                        <span className={`font-semibold mr-1 ${
                          msg.role === "user" ? "text-primary/70" : "text-amber-500"
                        }`}>
                          {msg.role === "user" ? "You:" : "Lightning AI:"}
                        </span>
                        {msg.text}
                      </div>
                    ))}
                    <div ref={aiMessagesEndRef} />
                  </div>
                )}

                {/* Quick actions */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {[
                    { label: "Explain", q: "Explain this slide." },
                    { label: "Summarise", q: "Summarise this slide." },
                    { label: "Key Points", q: "Give me the key points." },
                    { label: "Presenter Notes", q: "Give me presenter notes." },
                    { label: "What should I say?", q: "What should I say about this slide?" },
                    { label: "Example", q: "Give me a real-world example." },
                    { label: "Audience Q&A", q: "What questions might the audience ask?" },
                    { label: "Coach Me", q: "Coach me on presenting this slide." },
                  ].map(({ label, q }) => (
                    <button
                      key={label}
                      disabled={aiStatus === "loading"}
                      onClick={() => submitAIQuestion(q)}
                      className="rounded-full border border-amber-500/25 bg-background px-2.5 py-1 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/10 disabled:opacity-40"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Input */}
                <form
                  className="flex gap-2"
                  onSubmit={(e) => { e.preventDefault(); submitAIQuestion(); }}
                >
                  <input
                    ref={aiInputRef}
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    placeholder="Ask Lightning AI about this slide…"
                    disabled={aiStatus === "loading"}
                    className="flex-1 rounded-full border border-amber-500/25 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:opacity-50"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!aiInput.trim() || aiStatus === "loading"}
                    className="rounded-full bg-amber-500 text-white hover:bg-amber-600"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </form>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Or say: <span className="italic">"Lightning AI, explain this slide."</span>
                </p>
              </div>
            </div>
          )}
        </main>
      )}

      {(phase === "preview" || phase === "ready") && (
        <CameraWindow
          videoRef={videoRef}
          status={status}
          error={error}
          gesture={gesture}
          handVisible={handVisible}
          hidden={isFullscreen}
          pointingLabel={capabilities.writing ? "Index finger — cursor / pen" : undefined}
          twoFingerLabel={capabilities.writing ? "Index + middle — open toolbar" : undefined}
          onRetry={retry}
        />
      )}
    </div>
  );
}

function HowToControl({ planName }: { planName: string }) {
  const capabilities = capabilitiesForPlan(planName);
  const handControls = [
    { icon: "Palm", cmd: "Open Front Palm", desc: "Next Slide" },
    { icon: "Fist", cmd: "Close hand -> reopen Front Palm", desc: "Next Slide again" },
    { icon: "Back", cmd: "Back of Hand", desc: "Previous Slide" },
    { icon: "Fist", cmd: "Close hand -> reopen Back of Hand", desc: "Previous Slide again" },
    capabilities.writing
      ? {
          icon: "Tools",
          cmd: "Index + Middle Finger",
          desc: "Open / reopen the writing toolbar (once per raise)",
        }
      : { icon: "Point", cmd: "Raised Index Finger", desc: "Laser Pointer" },
    ...(capabilities.writing
      ? [
          {
            icon: "Pick",
            cmd: "Fingertip on a Color",
            desc: "Select that color, then move your fingertip to write",
          },
          {
            icon: "Minus",
            cmd: "Minus Button",
            desc: "Hide the toolbar — you keep writing",
          },
          {
            icon: "Tools",
            cmd: "Index + Middle Finger",
            desc: "Reopen the toolbar for a new color, Eraser, Erase All, Undo or Redo",
          },
        ]
      : []),
  ];
  const writingSteps = [
    "Raise INDEX + MIDDLE to open the toolbar.",
    "Use INDEX to select one of 5 colors.",
    "Move INDEX FINGER to write.",
    "Toolbar stays visible while writing.",
    "Click MINUS to minimize the toolbar.",
    "Continue writing while minimized.",
    "Raise INDEX + MIDDLE again to reopen the toolbar.",
    "Use Manual Eraser to erase selected marks.",
    "Use Erase All to clear writing on the current slide.",
    "Use Undo and Redo to correct writing.",
    "Writing remains separate for each slide.",
    "Original PPT/PPTX is never modified.",
    "Master Write has NO Laser Pointer.",
  ];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <HelpCircle className="mr-1 h-4 w-4" /> How to Control
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">How to Control</DialogTitle>
          <DialogDescription>
            {capabilities.ai
              ? "Hand + Voice + Writing + Lightning AI Controls"
              : capabilities.writing
                ? "Hand + Voice + Writing Controls"
                : capabilities.voice
                  ? "Hand + Voice Controls"
                  : "Hand + Camera"}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1 rounded-2xl border border-border bg-card p-4">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Hand className="h-4 w-4 text-primary" /> Hand + Camera
          </p>
          <ul className="space-y-3 text-sm">
            {handControls.map(({ icon, cmd, desc }) => (
              <li key={cmd} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="w-10 shrink-0 font-mono text-[11px] leading-5 text-primary"
                >
                  {icon}
                </span>
                <span>
                  <strong className="font-semibold">{cmd}</strong>
                  <span className="text-muted-foreground">
                    {" -> "}
                    {desc}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 rounded-lg bg-primary-soft/50 px-3 py-2 text-xs text-muted-foreground">
            {capabilities.writing
              ? "In Master Write, raise INDEX + MIDDLE to open the toolbar — it triggers once per raise (return to neutral before toggling again). Use INDEX to select a color, then move your INDEX finger to write directly under your fingertip. The toolbar stays visible while you write; click MINUS to minimize it while continuing to write. Raise INDEX + MIDDLE again to reopen. Manual Eraser, Erase All, Undo and Redo are in the toolbar. Writing is per-slide and your original presentation is never modified. Master Write has NO Laser Pointer."
              : "The laser pointer works only from your hand - a raised index finger. It is never triggered by voice."}
          </p>
        </div>

        {capabilities.voice && (
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Mic className="h-4 w-4 text-primary" /> Voice
            </p>
            <ul className="space-y-2.5 text-sm">
              {[
                { cmd: "next", desc: "Go to the next slide" },
                { cmd: "previous", desc: "Go to the previous slide" },
                { cmd: "8", desc: "Jump straight to Slide 8" },
                { cmd: "15", desc: "Jump straight to Slide 15" },
                { cmd: "eight", desc: "Number words work too — “eight” opens Slide 8" },
              ].map(({ cmd, desc }) => (
                <li key={cmd} className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-foreground whitespace-nowrap">
                    “{cmd}”
                  </span>
                  <span className="text-muted-foreground">→ {desc}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 rounded-lg bg-primary-soft/50 px-3 py-2 text-xs text-muted-foreground">
              The microphone starts automatically once you allow mic permission — no button needed.
              The status dot shows green when a command is detected, yellow while listening, red
              when voice is unavailable. Normal presentation speech is ignored — only these exact
              commands run, and they change slides silently with no sounds or spoken responses.
            </p>
          </div>
        )}

        {capabilities.writing && (
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Eraser className="h-4 w-4 text-primary" /> Master Write
            </p>
            <ol className="space-y-2.5 text-sm">
              {writingSteps.map((step, stepIndex) => (
                <li key={stepIndex} className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border bg-secondary font-mono text-[11px] text-foreground">
                    {stepIndex + 1}
                  </span>
                  <span className="text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 rounded-lg bg-primary-soft/50 px-3 py-2 text-xs text-muted-foreground">
              Remember the rhythm: INDEX + MIDDLE to open tools, INDEX to select a color, INDEX movement to write, MINUS to hide tools, and INDEX + MIDDLE to open tools again. Manual Eraser, Erase All, Undo and Redo are always available in the toolbar. The gesture fires once per raise — return to neutral between toggles. No laser pointer in Master Write. Writing and erasing are a frontend overlay — your original PPT/PPTX is never modified.
            </p>
          </div>
        )}
          {capabilities.ai && (
            <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
              <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-500">
                <Zap className="h-4 w-4" /> Lightning AI
              </p>
              <p className="mb-3 text-xs text-muted-foreground">
                LIGHTNING AI reads your actual slide content and answers questions in real time.
                Click <strong>Lightning AI</strong> in the control bar, or just say it:
              </p>
              <ul className="space-y-1.5">
                {[
                  "Lightning AI, explain this slide.",
                  "Lightning AI, summarize this slide.",
                  "Lightning AI, give me the key points.",
                  "Lightning AI, what should I say?",
                  "Lightning AI, give me presenter notes.",
                  "Lightning AI, give me a real-world example.",
                  "Lightning AI, what questions might the audience ask?",
                  "Lightning AI, help me answer this question.",
                  "Lightning AI, find the slide about [topic].",
                  "Lightning AI, coach me on this slide.",
                ].map((ex) => (
                  <li key={ex} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 shrink-0 rounded-md border border-amber-500/20 bg-background px-2 py-0.5 font-mono text-[10px] text-amber-600">
                      voice
                    </span>
                    <span className="italic text-muted-foreground">"{ex}"</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                LIGHTNING AI uses your actual slide text — no fake answers. It runs asynchronously
                and never blocks hand tracking, voice navigation, Master Write, laser or fullscreen.
                Quick action buttons are also available in the Lightning AI panel.
              </p>
            </div>
          )}
        </DialogContent>
    </Dialog>
  );
}
