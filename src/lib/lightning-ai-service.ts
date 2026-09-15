/**
 * Lightning AI Service
 *
 * Backend AI engine for LIGHTNING AI in Master Presenter (by LIGHTNING ATI).
 * V1 Implementation: Powered by Google Gemini (e.g. gemini-3.6-flash / gemini-flash-latest).
 *
 * Architecture:
 * - Server-side only: API keys are NEVER exposed to client JavaScript.
 * - Reads GEMINI_API_KEY from server environment variables / .env.
 * - Context-aware: Auto-injects current slide number, title, text, and speaker notes.
 * - Conversation memory: Preserves recent turns for natural follow-ups ("Make it simpler").
 * - Fallbacks: Cloudflare Workers AI binding (env.AI) or OpenAI if configured.
 */

export interface LightningAIRequest {
  question: string;
  slideText?: string;
  slideTitle?: string;
  slideIndex?: number;
  totalSlides?: number;
  speakerNotes?: string;
  intent?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface LightningAIResult {
  answer: string;
  provider?: string;
}

/** Centralized model configuration */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
export const FALLBACK_GEMINI_MODEL = "gemini-flash-latest";

const INTENT_HINTS: Record<string, string> = {
  explain: "Explain the current slide clearly and concisely for the presenter.",
  summarise: "Summarise the current slide content in 2-3 clear, impactful sentences.",
  keypoints: "Extract and list the key points from this slide as concise bullet points.",
  notes: "Write brief, practical presenter notes with cues for this slide.",
  speaker: "Tell the presenter exactly what to say about this slide in 3-5 natural, spoken sentences.",
  example: "Give one concrete, relevant real-world example directly illustrating this slide's topic.",
  qa: "List 3 likely questions an audience member might ask about this slide, along with concise answers.",
  answer: "Help the presenter answer the question asked, using the slide content as context.",
  search: "Identify the slide that best matches the topic requested by the presenter.",
  coach: "Give the presenter 2-3 actionable coaching tips for presenting this specific slide effectively.",
  general: "Answer the presenter's question using the slide content as context.",
};

/** Helper to read environment variables from env object, process.env, or .env files */
function resolveEnvKey(key: string, envObj?: Record<string, unknown>): string | undefined {
  if (envObj && typeof envObj[key] === "string" && envObj[key]) {
    return envObj[key] as string;
  }
  if (typeof process !== "undefined" && process.env?.[key]) {
    return process.env[key];
  }
  // Try reading local .env file in Node runtime if process.env wasn't pre-populated
  if (typeof process !== "undefined" && typeof require !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("path");
      for (const file of [".env", ".dev.vars", ".env.local"]) {
        const fullPath = path.resolve(process.cwd(), file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf8");
          const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
          if (match?.[1]) {
            const val = match[1].trim().replace(/^["']|["']$/g, "");
            process.env[key] = val;
            return val;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function processLightningAI(
  req: LightningAIRequest,
  env?: unknown,
): Promise<LightningAIResult> {
  const question = (req.question ?? "").trim();
  if (!question) {
    throw new Error("Question is required");
  }

  const slideTitle = (req.slideTitle ?? "").trim();
  const slideText = (req.slideText ?? "").trim();
  const speakerNotes = (req.speakerNotes ?? "").trim();
  const intent = (req.intent ?? "general").trim();
  const hint = INTENT_HINTS[intent] ?? INTENT_HINTS.general;

  const slideNumStr =
    typeof req.slideIndex === "number"
      ? `Slide ${req.slideIndex + 1}${req.totalSlides ? ` of ${req.totalSlides}` : ""}`
      : "";

  const hasSlideContext = Boolean(slideText || slideTitle || speakerNotes);
  const contextBlock = hasSlideContext
    ? `CURRENT SLIDE CONTEXT:
${slideNumStr ? `Location: ${slideNumStr}\n` : ""}Title: ${slideTitle || "(no title)"}
Content:
${slideText || "(no text on slide)"}
${speakerNotes ? `Speaker Notes: ${speakerNotes}\n` : ""}`
    : "No slide content is available for this request.";

  const systemPrompt = `You are LIGHTNING AI, an intelligent presentation assistant built into Master Presenter by LIGHTNING ATI.
Your role is to help the presenter with their presentation and CURRENT SLIDE during a live presentation.
Be concise, professional, clear, and presentation-ready. Ground your responses strictly in the provided slide content.
Never invent facts or details not present in the slide unless asked for an example or coaching.
${hint}
If the slide has no text or content, let the presenter know politely.
Keep answers clear and direct (under 150 words) so they can be read or referenced quickly while presenting.`;

  const envObj = (env as Record<string, unknown>) ?? {};

  // ── 1. Google Gemini (V1 Primary Engine) ──────────────────────────────────
  const geminiKey = resolveEnvKey("GEMINI_API_KEY", envObj);
  if (geminiKey) {
    const configuredModel = resolveEnvKey("GEMINI_MODEL", envObj) || DEFAULT_GEMINI_MODEL;
    const modelsToTry = [
      configuredModel,
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      FALLBACK_GEMINI_MODEL,
    ].filter((v, i, a) => a.indexOf(v) === i);

    // Format conversation history for Gemini contents array
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (Array.isArray(req.history)) {
      for (const h of req.history.slice(-6)) {
        if (h.content?.trim()) {
          contents.push({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content.trim() }],
          });
        }
      }
    }
    contents.push({
      role: "user",
      parts: [{ text: `${contextBlock}\n\nPRESENTER ASKS: ${question}` }],
    });

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 400,
            },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) {
            return { answer: text, provider: `gemini (${model})` };
          }
        } else {
          const errText = await res.text();
          console.warn(`[LIGHTNING AI] Gemini model ${model} returned ${res.status}, trying fallback...`);
          // Continue to next model in loop if 503/404/429
        }
      } catch (geminiErr) {
        console.warn(`[LIGHTNING AI] Gemini error with ${model}:`, geminiErr);
      }
    }
  }

  // ── 2. Cloudflare Workers AI binding (env.AI) fallback ───────────────────
  const aiBinding = envObj["AI"] as
    | { run: (model: string, input: unknown) => Promise<unknown> }
    | undefined;

  if (aiBinding && typeof aiBinding.run === "function") {
    try {
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
      ];
      if (Array.isArray(req.history)) {
        for (const h of req.history.slice(-6)) {
          if ((h.role === "user" || h.role === "assistant") && h.content?.trim()) {
            messages.push({ role: h.role, content: h.content.trim() });
          }
        }
      }
      messages.push({
        role: "user",
        content: `${contextBlock}\n\nPRESENTER ASKS: ${question}`,
      });

      const result = (await aiBinding.run("@cf/meta/llama-3.1-8b-instruct", {
        messages,
        max_tokens: 350,
        temperature: 0.4,
      })) as { response?: string } | undefined;

      const ans = result?.response?.trim();
      if (ans) {
        return { answer: ans, provider: "cloudflare-workers-ai" };
      }
    } catch (cfErr) {
      console.error("[LIGHTNING AI] Cloudflare Workers AI binding error:", cfErr);
    }
  }

  // ── 3. OpenAI REST API fallback ──────────────────────────────────────────
  const openaiKey = resolveEnvKey("OPENAI_API_KEY", envObj);
  if (openaiKey) {
    try {
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
      ];
      if (Array.isArray(req.history)) {
        for (const h of req.history.slice(-6)) {
          if ((h.role === "user" || h.role === "assistant") && h.content?.trim()) {
            messages.push({ role: h.role, content: h.content.trim() });
          }
        }
      }
      messages.push({
        role: "user",
        content: `${contextBlock}\n\nPRESENTER ASKS: ${question}`,
      });

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 350,
          temperature: 0.4,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return { answer: text, provider: "openai" };
        }
      } else {
        const errText = await res.text();
        console.error(`[LIGHTNING AI] OpenAI API returned ${res.status}:`, errText);
      }
    } catch (openaiErr) {
      console.error("[LIGHTNING AI] OpenAI request error:", openaiErr);
    }
  }

  // ── Missing configuration ────────────────────────────────────────────────
  if (!geminiKey && !aiBinding && !openaiKey) {
    throw new Error(
      "LIGHTNING AI is not configured. Please set GEMINI_API_KEY in your environment, or deploy with Cloudflare Workers AI binding.",
    );
  }

  throw new Error("LIGHTNING AI is temporarily unavailable. Please try again.");
}
