/**
 * Lightning AI Service
 *
 * Provides inference for LIGHTNING AI in Master Presenter.
 * Architecture:
 * 1. Primary: Cloudflare Workers AI native binding (env.AI) using @cf/meta/llama-3.1-8b-instruct
 * 2. Fallback: Google Gemini REST API (GEMINI_API_KEY)
 * 3. Fallback: OpenAI REST API (OPENAI_API_KEY)
 * 4. Fallback: Cloudflare Workers AI REST API (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
 *
 * Never exposes secrets to frontend JavaScript.
 * Validates responses, supports conversation history for natural follow-ups,
 * and passes current slide context (slide number, title, text, speaker notes).
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

const INTENT_HINTS: Record<string, string> = {
  explain: "Explain the current slide clearly and concisely for the presenter.",
  summarise: "Summarise the current slide content in 2-3 concise sentences.",
  keypoints: "Extract and list the key points from this slide as clear bullet points.",
  notes: "Write brief, practical presenter notes for this slide.",
  speaker: "Tell the presenter exactly what to say about this slide in 3-5 natural, spoken sentences.",
  example: "Give one concrete, relevant real-world example directly illustrating this slide's topic.",
  qa: "List 3 likely questions an audience member might ask about this slide, along with concise answers.",
  answer: "Help the presenter answer the question asked, using the slide content as context.",
  search: "Identify the slide that best matches the topic requested by the presenter.",
  coach: "Give the presenter 2-3 actionable coaching tips for presenting this specific slide effectively.",
  general: "Answer the presenter's question using the slide content as context.",
};

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
${slideNumStr ? `Position: ${slideNumStr}\n` : ""}Title: ${slideTitle || "(no title)"}
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

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Include recent conversation history for natural follow-ups ("Make it simpler", "Give me an example")
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

  const envObj = (env as Record<string, unknown>) ?? {};

  // ── 1. Cloudflare Workers AI native binding (env.AI) ───────────────────────
  const aiBinding = envObj["AI"] as
    | { run: (model: string, input: unknown) => Promise<unknown> }
    | undefined;

  if (aiBinding && typeof aiBinding.run === "function") {
    try {
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

  // Helper to read env var from envObj or process.env
  const getEnvVar = (key: string): string | undefined => {
    if (typeof envObj[key] === "string" && envObj[key]) return envObj[key] as string;
    if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
    return undefined;
  };

  // ── 2. Google Gemini REST API ─────────────────────────────────────────────
  const geminiKey = getEnvVar("GEMINI_API_KEY");
  if (geminiKey) {
    try {
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

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 350,
            },
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          return { answer: text, provider: "gemini" };
        }
      } else {
        const errText = await res.text();
        console.error(`[LIGHTNING AI] Gemini API returned ${res.status}:`, errText);
      }
    } catch (geminiErr) {
      console.error("[LIGHTNING AI] Gemini request error:", geminiErr);
    }
  }

  // ── 3. OpenAI REST API ────────────────────────────────────────────────────
  const openaiKey = getEnvVar("OPENAI_API_KEY");
  if (openaiKey) {
    try {
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

  // ── 4. Cloudflare Workers AI REST API ─────────────────────────────────────
  const cfToken = getEnvVar("CLOUDFLARE_API_TOKEN");
  const cfAccountId = getEnvVar("CLOUDFLARE_ACCOUNT_ID");
  if (cfToken && cfAccountId) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfToken}`,
          },
          body: JSON.stringify({
            messages,
            max_tokens: 350,
            temperature: 0.4,
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as { result?: { response?: string } };
        const text = data.result?.response?.trim();
        if (text) {
          return { answer: text, provider: "cloudflare-rest" };
        }
      } else {
        const errText = await res.text();
        console.error(`[LIGHTNING AI] Cloudflare REST returned ${res.status}:`, errText);
      }
    } catch (cfRestErr) {
      console.error("[LIGHTNING AI] Cloudflare REST error:", cfRestErr);
    }
  }

  // If no AI provider succeeded or none was configured, return an actionable, honest error.
  throw new Error(
    "LIGHTNING AI is not configured. Please set GEMINI_API_KEY, OPENAI_API_KEY, or deploy with Cloudflare Workers AI binding.",
  );
}
