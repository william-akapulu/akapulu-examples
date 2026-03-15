import { NextRequest } from "next/server";

/*
This route is a thin server-side proxy between the browser demo and the Akapulu API.

Why this exists:
- Keeps `AKAPULU_API_KEY` on the server (never exposed to client-side JS).
- Gives the demo a stable local endpoint (`/api/demo`) for both connect + updates.
- Lets the frontend call one path while this route handles auth + upstream URLs.
*/
const AKAPULU_API_BASE_URL = "https://akapulu/api";

export async function POST(request: NextRequest) {
  // Server-side secret used to authenticate against the upstream API.
  const apiKey = process.env.AKAPULU_API_KEY || "";
  // Frontend sends scenario/runtime info here; invalid JSON falls back to {}.
  const body = await request.json().catch(() => ({}));
  // Connect requires a scenario id to choose which flow to run.
  const scenarioId = typeof body?.scenario_id === "string" ? body.scenario_id.trim() : "";

  if (apiKey === "") {
    return Response.json(
      { error: "Missing AKAPULU_API_KEY environment variable." },
      { status: 500 },
    );
  }
  if (scenarioId === "") {
    return Response.json(
      { error: "scenario_id is required." },
      { status: 400 },
    );
  }

  // Conversation Connect: creates a new session and returns Daily credentials
  // plus a conversation_session_id used for readiness polling.
  const response = await fetch(`${AKAPULU_API_BASE_URL}/conversations/connect/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      scenario_id: scenarioId,
      // Forward optional runtime vars from UI to scenario runtime context.
      runtime_vars: body?.runtime_vars,
      // Normalized to strict boolean before forwarding.
      voice_only_mode: body?.voice_only_mode === true,
      // Hint for backend/demo behavior specific to this custom UI flow.
      custom_rtvi_connection: true,
    }),
  });

  // Pass through upstream payload/status so frontend can handle both success/errors.
  const payload = await response.json();
  return Response.json(payload, { status: response.status });
}

export async function GET(request: NextRequest) {
  // Same server-side auth strategy as POST; key never leaves server.
  const apiKey = process.env.AKAPULU_API_KEY || "";
  // Session id from query string identifies which setup progress to read.
  const conversationSessionId = request.nextUrl.searchParams.get("conversation_session_id") || "";

  if (apiKey === "") {
    return Response.json(
      { error: "Missing AKAPULU_API_KEY environment variable." },
      { status: 500 },
    );
  }

  if (conversationSessionId === "") {
    return Response.json(
      { error: "conversation_session_id is required." },
      { status: 400 },
    );
  }

  // Conversation Updates: returns setup milestone state used by connecting UI
  // (`completion_percent`, `latest_update_text`, `call_is_ready`, etc.).
  const response = await fetch(
    `${AKAPULU_API_BASE_URL}/conversations/${conversationSessionId}/updates/`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  // Preserve upstream status so polling logic can react to non-200 responses.
  const payload = await response.json();
  return Response.json(payload, { status: response.status });
}
