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
  explain: "Explain the current slide clearly and thoroughly. Cover the main concept, why it matters, and any key details visible in the slide content.",
  summarise: "Summarise the current slide content fully. Cover all the main points so the presenter understands everything on the slide.",
  keypoints: "Extract and list ALL the key points from this slide as clear, complete bullet points. Do not skip any important point.",
  notes: "Write complete, practical presenter notes for this slide. Include speaking cues, what to emphasise, and what to avoid. Cover the full slide.",
  speaker: "Write a complete natural presenter script for this slide — everything the presenter should say, in natural spoken language, covering the full slide content.",
  example: "Give a clear, concrete, relevant real-world example that directly illustrates this slide's topic. Explain why it connects to the slide.",
  qa: "List the most likely questions an audience member might ask about this slide AND provide a clear, useful answer for each question.",
  answer: "Help the presenter answer the question asked, using the slide content as context.",
  search: "Identify the slide that best matches the topic requested by the presenter.",
  coach: "Give the presenter complete, practical coaching advice on how to present this specific slide effectively. Include tips on pacing, emphasis, audience engagement, and delivery.",
  general: "Answer the presenter's question thoroughly using the slide content as context.",
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
  const hint = INTENT_HINTS[intent] ?? INTENT_HINTS["general"] ?? "";

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

  const systemPrompt = `You are LIGHTNING AI, a presentation assistant built into Master Presenter by LIGHTNING ATI.

Your job is to help the presenter understand and deliver the currently selected slide.

RULES:
- Always use the provided CURRENT SLIDE CONTEXT as your primary source.
- Answer specifically about the current slide. Do not invent slide content or pretend to see information that was not provided.
- Never return a truncated or incomplete answer. Always complete your full response.
- When useful, structure answers with clear headings and bullet points so the presenter can scan them quickly.
- For presenter requests ("What should I say?", "Presenter Notes"), give natural language that can be spoken aloud.
- For audience questions, provide BOTH the likely questions AND useful answers.
- For coaching, give practical, actionable presentation advice.
- If the slide content is insufficient to answer something fully, clearly say what information is missing rather than guessing.
- Be professional, clear, and thorough. Do not cut answers short.

${hint}`;

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
              maxOutputTokens: 800,
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
        max_tokens: 800,
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
          max_tokens: 800,
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
