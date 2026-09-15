import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

import { globalSessionTracker } from "./lib/session-tracker";
import {
  getCumulativeStats,
  recordSessionStart,
  recordSessionEnd,
  recordDownload,
} from "./lib/cumulative-stats";

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    // ── LIGHTNING AI ──────────────────────────────────────────────────────────
    // POST /api/lightning-ai
    // Body: { question: string; slideText: string; slideTitle: string; intent: string }
    // Uses Cloudflare Workers AI binding (env.AI). If the binding is absent
    // (local dev or unconfigured deployment) the endpoint returns 503 so the
    // frontend shows a clean "unavailable" message rather than crashing.

    if (url.pathname === "/api/lightning-ai" && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/api/lightning-ai" && request.method === "POST") {
      const aiEnv = env as Record<string, unknown>;
      const aiBinding = aiEnv["AI"] as
        | { run: (model: string, input: unknown) => Promise<unknown> }
        | undefined;

      if (!aiBinding) {
        return new Response(
          JSON.stringify({
            error: "unavailable",
            message: "LIGHTNING AI is temporarily unavailable. Please try again.",
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      try {
        const body = (await request.json()) as {
          question?: string;
          slideText?: string;
          slideTitle?: string;
          intent?: string;
        };

        const question = (body.question ?? "").trim();
        const slideTitle = (body.slideTitle ?? "").trim();
        const slideText = (body.slideText ?? "").trim();
        const intent = (body.intent ?? "general").trim();

        if (!question) {
          return new Response(JSON.stringify({ error: "question is required" }), {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Build a tightly-scoped system prompt so LIGHTNING AI always answers
        // from the actual slide content and never invents slide details.
        const hasSlideContext = Boolean(slideText || slideTitle);
        const contextBlock = hasSlideContext
          ? `CURRENT SLIDE CONTEXT:\nTitle: ${slideTitle || "(no title)"}\nContent: ${slideText || "(no text detected)"}`
          : "No slide content is available for this request.";

        const intentHint: Record<string, string> = {
          explain: "Explain the slide content clearly and concisely for the presenter.",
          summarise: "Summarise the slide content in 2-3 sentences.",
          keypoints: "List the key points from the slide as bullet points.",
          notes: "Write brief presenter notes for this slide.",
          speaker: "Tell the presenter what to say about this slide in 3-5 sentences.",
          example: "Give one real-world example related to the slide content.",
          qa: "List 3 questions an audience member might ask about this slide.",
          answer:
            "Help the presenter answer the question asked, using the slide content as context.",
          search: "Based on the slide content provided, confirm if this slide matches the topic.",
          coach: "Give the presenter 2-3 coaching tips for presenting this slide effectively.",
          general: "Answer the presenter's question using the slide content as context.",
        };

        const hint = intentHint[intent] ?? intentHint["general"]!;

        const systemPrompt = `You are LIGHTNING AI, a smart presentation assistant built into Master Presenter.
Your role is to help the presenter with their CURRENT SLIDE during a live presentation.
Be concise, clear, and presentation-ready. Never invent slide content.
${hint}
If the slide has no content, say so honestly.
Keep answers under 150 words unless the presenter asks for detail.`;

        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `${contextBlock}\n\nPRESENTER ASKS: ${question}` },
        ];

        const result = (await aiBinding.run("@cf/meta/llama-3.1-8b-instruct", {
          messages,
          max_tokens: 300,
          temperature: 0.4,
        })) as { response?: string } | undefined;

        const answer =
          typeof (result as any)?.response === "string"
            ? ((result as any).response as string).trim()
            : "LIGHTNING AI could not generate a response. Please try again.";

        return new Response(JSON.stringify({ answer }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        console.error("LIGHTNING AI error:", err);
        return new Response(
          JSON.stringify({
            error: "ai_error",
            message: "LIGHTNING AI is temporarily unavailable. Please try again.",
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // ── Health check ──────────────────────────────────────────────────────────


    if (url.pathname === "/health" || url.pathname === "/ping") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: (globalThis as any).process?.uptime?.() ?? 0,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        },
      );
    }

    if (url.pathname === "/stats/live" && request.method === "GET") {
      return new Response(
        JSON.stringify({ active_users: globalSessionTracker.getActiveCount() }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        },
      );
    }

    // ── Cumulative statistics ─────────────────────────────────────────────────

    if ((url.pathname === "/api/stats" || url.pathname === "/stats/cumulative") && request.method === "GET") {
      try {
        const stats = await getCumulativeStats();
        return new Response(JSON.stringify(stats), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      } catch {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if ((url.pathname === "/api/stats/download" || url.pathname === "/stats/download") && request.method === "POST") {
      try {
        let body: { client_id?: string } = {};
        const text = await request.text();
        if (text) {
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            // raw text
          }
        }
        if (body?.client_id) {
          await recordDownload(body.client_id);
        }
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/stats/session/start" && request.method === "POST") {
      try {
        const body = (await request.json()) as { client_id?: string; session_id?: string };
        if (body?.client_id) {
          await recordSessionStart(body.client_id, body.session_id);
        }
      } catch {
        // ignore JSON parse or store errors — never block the presenter
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/stats/session/end" && request.method === "POST") {
      try {
        let body: { client_id?: string; session_id?: string; duration_seconds?: number } = {};
        const text = await request.text();
        if (text) {
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            // raw text or sendBeacon with non-JSON
          }
        }
        const duration = typeof body.duration_seconds === "number" ? body.duration_seconds : 0;
        await recordSessionEnd(duration);
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/sessions/heartbeat" && request.method === "POST") {
      try {
        const body = (await request.json()) as { client_id?: string; session_id?: string };
        if (body?.client_id) {
          const active = globalSessionTracker.heartbeat(body.client_id, body.session_id);
          return new Response(JSON.stringify({ status: "ok", active_users: active }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      } catch {
        // ignore JSON parse failure
      }
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/sessions/end" && request.method === "POST") {
      try {
        let body: { client_id?: string; session_id?: string } = {};
        const text = await request.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            // raw text or sendBeacon
          }
        }
        if (body?.client_id) {
          const active = globalSessionTracker.endSession(body.client_id, body.session_id);
          return new Response(JSON.stringify({ status: "ok", active_users: active }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
