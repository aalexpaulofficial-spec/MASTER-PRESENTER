/**
 * useLightningAI — calls /api/lightning-ai with the presenter's question
 * and the current slide's extracted text, then surfaces the AI response.
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
function detectIntent(question: string): string {
  const q = question.toLowerCase();
  if (/explain|what (does|is)|describe/.test(q)) return "explain";
  if (/summar/.test(q)) return "summarise";
  if (/key point|main point|bullet/.test(q)) return "keypoints";
  if (/presenter note|note/.test(q)) return "notes";
  if (/what should i say|what do i say|how should i present/.test(q)) return "speaker";
  if (/example|real.world|illustrat/.test(q)) return "example";
  if (/question.*(audience|ask|might)|audience.*question/.test(q)) return "qa";
  if (/answer|respond|help me/.test(q)) return "answer";
  if (/find.*slide|which slide|slide about|search/.test(q)) return "search";
  if (/coach|tip|advice|improve/.test(q)) return "coach";
  return "general";
}

/** Build a flat text summary of the current slide for the AI. */
function buildSlideText(slide: SlideText | undefined | null): string {
  if (!slide) return "";
  const parts: string[] = [];
  for (const el of slide.text_elements ?? []) {
    const t = el.text?.trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
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

      const currentSlide = metadata?.[slideIndex] ?? null;
      const slideText = buildSlideText(currentSlide);
      const slideTitle = currentSlide?.title ?? "";
      const intent = detectIntent(q);

      const userMsg: LightningAIMessage = {
        id: Math.random().toString(36).slice(2),
        role: "user",
        text: q,
      };

      setMessages((prev) => [...prev, userMsg]);
      setStatus("loading");

      void fetch("/api/lightning-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, slideText, slideTitle, intent }),
        signal: controller.signal,
      })
        .then(async (res) => {
          const json = (await res.json()) as { answer?: string; message?: string; error?: string };
          if (controller.signal.aborted) return;

          const text =
            json.answer ??
            json.message ??
            "LIGHTNING AI is temporarily unavailable. Please try again.";

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
    [metadata, slideIndex],
  );

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("idle");
  }, []);

  return { messages, status, ask, clearMessages };
}
