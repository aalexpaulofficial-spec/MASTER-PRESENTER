/**
 * useLightningAI — calls /api/lightning-ai with the presenter's question,
 * current slide context (slide number, total slides, title, text, notes),
 * and conversation history for follow-up questions.
 *
 * Fully async: never blocks hand tracking, voice control, Master Write,
 * laser pointer or slide navigation.
 */

import { useCallback, useRef, useState } from "react";
import type { SlideText } from "@/lib/pptx-text";

export type LightningAIStatus = "idle" | "loading" | "done" | "error";

export type LightningAIMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

/** Infer an intent keyword from the question text. */
export function detectIntent(question: string): string {
  const q = question.toLowerCase();
  if (/find.*slide|which slide|slide about|search for slide/.test(q)) return "search";
  if (/explain|what (does|is)|describe/.test(q)) return "explain";
  if (/summar/.test(q)) return "summarise";
  if (/key point|main point|bullet/.test(q)) return "keypoints";
  if (/presenter note|speaker note|\bnote\b/.test(q)) return "notes";
  if (/what should i say|what do i say|how should i present/.test(q)) return "speaker";
  if (/example|real.world|illustrat/.test(q)) return "example";
  if (/question.*(audience|ask|might)|audience.*question/.test(q)) return "qa";
  if (/answer|respond|help me answer/.test(q)) return "answer";
  if (/coach|tip|advice|improve/.test(q)) return "coach";
  return "general";
}

/** Build a flat text summary of the current slide for the AI. */
export function buildSlideText(slide: SlideText | undefined | null): string {
  if (!slide) return "";
  const parts: string[] = [];
  for (const el of slide.text_elements ?? []) {
    const t = el.text?.trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

/** Search all slides for a topic keyword. */
function findMatchingSlide(
  metadata: SlideText[] | null,
  query: string,
): { slide: SlideText; index: number } | null {
  if (!metadata || metadata.length === 0) return null;

  // Extract topic after "about", "find", "search", "slide"
  const m = query.match(/(?:about|for|on)\s+([^?.!]+)/i) || query.match(/(?:find|search)\s+(?:the\s+)?(?:slide\s+)?([^?.!]+)/i);
  const rawTopic = (m?.[1] ?? query).trim();

  const words = rawTopic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|about|slide|which|find|show|for|and|please)$/.test(w));

  if (words.length === 0) return null;

  let bestIndex = -1;
  let maxScore = 0;

  for (let i = 0; i < metadata.length; i++) {
    const s = metadata[i];
    if (!s) continue;
    const title = (s.title ?? "").toLowerCase();
    const content = buildSlideText(s).toLowerCase();
    let score = 0;

    for (const w of words) {
      if (title.includes(w)) score += 6;
      if (content.includes(w)) score += 2;
    }

    if (score > maxScore) {
      maxScore = score;
      bestIndex = i;
    }
  }

  return bestIndex >= 0 && maxScore > 0
    ? { slide: metadata[bestIndex]!, index: bestIndex }
    : null;
}

export type UseLightningAIReturn = {
  messages: LightningAIMessage[];
  status: LightningAIStatus;
  /** Call with the presenter's question. Slide context is auto-injected. */
  ask: (question: string) => void;
  clearMessages: () => void;
};

export function useLightningAI(
  /** The metadata array from pptx-text (or null while loading). */
  metadata: SlideText[] | null,
  /** Zero-based index of the current slide. */
  slideIndex: number,
  /** Optional callback to navigate to a slide (used for semantic slide search). */
  onNavigateToSlide?: (targetIndex: number) => void,
): UseLightningAIReturn {
  const [messages, setMessages] = useState<LightningAIMessage[]>([]);
  const [status, setStatus] = useState<LightningAIStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;

      // Cancel any in-flight request.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: LightningAIMessage = {
        id: Math.random().toString(36).slice(2),
        role: "user",
        text: q,
      };

      setMessages((prev) => [...prev, userMsg]);
      setStatus("loading");

      const intent = detectIntent(q);

      // Handle Semantic Slide Search immediately if presentation has slides
      if (intent === "search" && metadata && metadata.length > 0) {
        const match = findMatchingSlide(metadata, q);
        if (match) {
          if (typeof onNavigateToSlide === "function") {
            onNavigateToSlide(match.index);
          }
          const slideTitleText = match.slide.title ? ` ("${match.slide.title}")` : "";
          const assistantMsg: LightningAIMessage = {
            id: Math.random().toString(36).slice(2),
            role: "assistant",
            text: `Found Slide ${match.index + 1}${slideTitleText}. Navigated directly to slide ${match.index + 1}.`,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setStatus("done");
          return;
        }
      }

      const currentSlide = metadata?.[slideIndex] ?? null;
      const slideText = buildSlideText(currentSlide);
      const slideTitle = currentSlide?.title ?? "";
      const speakerNotes = (currentSlide as any)?.notes ?? "";
      const totalSlides = metadata?.length ?? 0;

      // Collect recent conversation history for natural follow-ups
      const history = messages.slice(-6).map((m) => ({
        role: m.role,
        content: m.text,
      }));

      void fetch("/api/lightning-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          slideText,
          slideTitle,
          slideIndex,
          totalSlides,
          speakerNotes,
          intent,
          history,
        }),
        signal: controller.signal,
      })
        .then(async (res) => {
          const json = (await res.json().catch(() => ({}))) as {
            answer?: string;
            message?: string;
            error?: string;
          };
          if (controller.signal.aborted) return;

          const text =
            json.answer ??
            json.message ??
            (res.ok
              ? "No response generated."
              : "LIGHTNING AI is temporarily unavailable. Please try again.");

          const assistantMsg: LightningAIMessage = {
            id: Math.random().toString(36).slice(2),
            role: "assistant",
            text,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setStatus(res.ok ? "done" : "error");
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return;
          const assistantMsg: LightningAIMessage = {
            id: Math.random().toString(36).slice(2),
            role: "assistant",
            text: "LIGHTNING AI is temporarily unavailable. Please try again.",
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setStatus("error");
        });
    },
    [metadata, slideIndex, messages, onNavigateToSlide],
  );

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("idle");
  }, []);

  return { messages, status, ask, clearMessages };
}
