"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import { PipecatClientProvider, PipecatClientAudio, usePipecatClient } from "@pipecat-ai/client-react";
import { DailyProvider, useDaily, useParticipantIds, DailyVideo, useVideoTrack } from "@daily-co/daily-react";
import { DailyTransport } from "@pipecat-ai/daily-transport";
import { Mic, MicOff, PhoneOff, Eye, Database, Globe } from "lucide-react";
import styles from "./Demo.module.css";

/*
High-level architecture of this page:

1) Configure call inputs at the top:
   - Scenario ID, avatar ID, runtime vars, and voice-only mode.

2) Start flow:
   - Frontend POSTs to `/api/demo`.
   - `/api/demo` is a server-side proxy that calls Akapulu `/conversations/connect/`
     with the API key on the server.
   - Akapulu returns `room_url`, `token`, and `conversation_session_id`.
   - Frontend joins the Daily call through Pipecat `client.connect(...)`.

3) Readiness flow:
   - Frontend polls `/api/demo?conversation_session_id=...`.
   - Proxy forwards to Akapulu `/conversations/<id>/updates/`.
   - UI uses `completion_percent`, `latest_update_text`, and `call_is_ready`
     to power the connecting progress experience.

4) Live call flow:
   - Daily hooks drive media and participant state (video tiles, mute, presence).
   - Pipecat RTVI events drive transcript and server-message UI state.
   - Tool calls and flow-node changes are rendered as UI diagnostics.

5) Provider layering:
   - `PipecatClientProvider` = app-level realtime client context.
   - `DailyProvider` = media and participant context via Daily call object.
   - `PipecatClientAudio` = assistant audio output element.
*/



// -----------------------------------------------------------------------------
// CUSTOMIZATION START
// Edit these first when reusing this demo in another project.
// -----------------------------------------------------------------------------


const DEMO_PAGE_TITLE = "Akapulu Custom UI Demo";
// Scenario UUID from the dashboard ("Scenario details" section).
const DEMO_SCENARIO_ID = "<SCENARIO_ID>";
// Avatar UUID from your account or the public catalog.
const DEMO_AVATAR_ID = "d20e3ec3-b713-4e5e-aa5b-02f09031a339";
// Variables injected at connect-time; keep keys aligned with your scenario.
const DEMO_RUNTIME_VARS: Record<string, string> = {};
// Set true to hide video surfaces and run as a voice-first UI.
const VOICE_ONLY_MODE = false;


// -----------------------------------------------------------------------------
// CUSTOMIZATION END
// -----------------------------------------------------------------------------







// Rotating colors for stage chips shown when flow nodes change.
const STAGE_COLOR_POOL = ["#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#f472b6"];
// Spinner while backend setup is still in progress.
const pulseKeyframes = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`;
// Visual theme for tool-event toast cards.
const TOOL_THEME: Record<string, { border: string; title: string }> = {
  vision: { border: "1px solid rgba(34, 211, 238, 0.45)", title: "#67e8f9" },
  RAG: { border: "1px solid rgba(167, 139, 250, 0.45)", title: "#c4b5fd" },
  http: { border: "1px solid rgba(52, 211, 153, 0.45)", title: "#6ee7b7" },
};
// Icon mapping for each supported tool event type.
const TOOL_ICON = {
  vision: <Eye size={14} />,
  RAG: <Database size={14} />,
  http: <Globe size={14} />,
};

// Gives each node transition a distinct stage-chip color.
function getCycledStageColor(index: number) {
  return STAGE_COLOR_POOL[index % STAGE_COLOR_POOL.length] || "#818cf8";
}

// Transcript row model for streamed STT (user) and streamed TTS/LLM text (bot).
interface TranscriptEntry {
  id: string;
  text: string;
  speaker: "user" | "bot";
  timestamp: Date;
  isFinal: boolean;
}

// Normalized payload used by the tool-activity toast.
interface FunctionCallToast {
  messageType: string;
  functionName: string;
  summary: string;
  query?: string;
  args?: Array<{ key: string; value: string }>;
  argsJson?: string;
}



// -----------------------------------------------------------------------------
// VideoTile
// Shared Daily tile for local user and remote assistant participant.
// If a track is unavailable, render initials/name so call state is still visible.
// -----------------------------------------------------------------------------
const VideoTile = ({ id, isLocal }: { id: string; isLocal: boolean }) => {
  const daily = useDaily();
  const participant = daily?.participants()[id];
  const videoTrack = useVideoTrack(id);
  const isVideoOff = videoTrack.isOff;

  if (isVideoOff) {
    // Daily can report participant presence before video is receivable.
    return (
      <div
        style={{
          width: "100%",
          backgroundColor: "#232323",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          padding: "2rem 1rem",
          textAlign: "center",
        }}
      >
        <div>
          <span style={{ fontSize: "48px", fontWeight: "bold" }}>
            {isLocal ? "Y" : participant?.user_name?.charAt(0) || "B"}
          </span>
          <p style={{ marginTop: "8px", fontWeight: 500 }}>
            {isLocal ? "You" : participant?.user_name || "Bot"}
          </p>
        </div>
      </div>
    );
  }

  // Render live Daily video when the track is available.
  return (
    <DailyVideo
      automirror={isLocal}
      sessionId={id}
      type="video"
      style={{ width: "100%", height: "auto", display: "block" }}
    />
  );
};

function CustomRtviDemo() {
  // This demo intentionally keeps core logic in one file so implementers can
  // map the end-to-end Akapulu + Pipecat + Daily flow without jumping files.

  // ---------------------------------------------------------------------------
  // Transport/session hooks
  // ---------------------------------------------------------------------------
  const client = usePipecatClient();
  const daily = useDaily();
  const remoteParticipantIds = useParticipantIds({ filter: "remote" });
  const localParticipantId = daily?.participants()?.local?.session_id || "";
  const localParticipant = daily?.participants().local;

  // ---------------------------------------------------------------------------
  // UI state for lifecycle, progress, transcript, and tool-call diagnostics
  // ---------------------------------------------------------------------------
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [currentStageColor, setCurrentStageColor] = useState("#818cf8");
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [conversationSessionId, setConversationSessionId] = useState<string | null>(null);
  const [callIsReady, setCallIsReady] = useState(false);
  const [completionPercent, setCompletionPercent] = useState(0);
  const [latestUpdateText, setLatestUpdateText] = useState("Initializing conversation...");
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectErrorCode, setConnectErrorCode] = useState<string | null>(null);
  const [functionCallToast, setFunctionCallToast] = useState<FunctionCallToast | null>(null);
  const [botSpeakingState, setBotSpeakingState] = useState<"idle" | "speaking" | "listening">("idle");

  // ---------------------------------------------------------------------------
  // Mutable per-session flags; refs avoid extra rerenders during streaming.
  // ---------------------------------------------------------------------------
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Guard flag so reconnects or progress jitter cannot trigger duplicate recording starts.
  const recordingStartRequestedRef = useRef(false);
  // Toast lifecycle is timer-driven, so timeout id is stored outside render state.
  const functionToastTimeoutRef = useRef<number | null>(null);
  // Color index is render-independent; using a ref avoids unnecessary rerenders.
  const stageColorIndexRef = useRef(0);

  // Flattens nested tool payload values into readable inline text.
  const formatToolArgValue = (value: unknown) => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map((item) => formatToolArgValue(item)).join(", ");
    if (typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${formatToolArgValue(v)}`)
        .join(", ");
    }
    return String(value);
  };

  // Keep transcript pinned to latest message while text streams in.
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcripts]);

  // ---------------------------------------------------------------------------
  // Connect/disconnect actions
  // ---------------------------------------------------------------------------
  const startCall = useCallback(async () => {
    if (!client) return;

    // Reset UI and per-run flags before starting a fresh Akapulu session.
    recordingStartRequestedRef.current = false;
    setStatus("connecting");
    setTranscripts([]);
    setCallIsReady(false);
    setCompletionPercent(0);
    setLatestUpdateText("Initializing conversation...");
    setConversationSessionId(null);
    setIsMicMuted(false);
    stageColorIndexRef.current = 0;
    setConnectError(null);
    setConnectErrorCode(null);
    setBotSpeakingState("idle");

    const startResponse = await fetch("/api/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Frontend calls local `/api/demo` only.
      // That route calls Akapulu `/conversations/connect/` server-side, then
      // returns Daily credentials + conversation_session_id back to the browser.
      body: JSON.stringify({
        scenario_id: DEMO_SCENARIO_ID,
        avatar_id: DEMO_AVATAR_ID, // UUID, not handle
        runtime_vars: DEMO_RUNTIME_VARS,
        voice_only_mode: VOICE_ONLY_MODE,
      }),
    });

    if (!startResponse.ok) {
      const errorPayload = await startResponse.json();
      // Prefer backend-provided message/code, fallback to HTTP status.
      const errorMessage =
        typeof errorPayload?.error === "string" && errorPayload.error !== ""
          ? errorPayload.error
          : `Failed to start call (${startResponse.status})`;
      const backendCode =
        errorPayload?.error_code || errorPayload?.code || errorPayload?.status_code || startResponse.status;
      setConnectError(errorMessage);
      setConnectErrorCode(String(backendCode));
      setStatus("idle");
      return;
    }

    // Store conversation_session_id so we can poll Akapulu setup updates.
    const startData = await startResponse.json();
    setConnectErrorCode(null);
    setConversationSessionId(startData.conversation_session_id || null);

    // Join the call via Pipecat client; Daily transport is used under the hood.
    // Sequence is explicit: connect API first, media join second.
    await client.connect({
      room_url: startData.room_url,
      token: startData.token,
    } as any);
  }, [client]);

  const endCall = useCallback(async () => {
    if (!client) return;

    // Leave transport and reset local state so the next run starts clean.
    await client.disconnect();
    recordingStartRequestedRef.current = false;
    setStatus("idle");
    setConversationSessionId(null);
    setCallIsReady(false);
    setCompletionPercent(0);
    setLatestUpdateText("Initializing conversation...");
    setCurrentStage(null);
    setCurrentStageColor("#818cf8");
    stageColorIndexRef.current = 0;
    setFunctionCallToast(null);
    setIsMicMuted(false);
    setBotSpeakingState("idle");
  }, [client]);

  const toggleMute = useCallback(() => {
    if (!daily) return;

    const nextMuted = !isMicMuted;
    daily.setLocalAudio(!nextMuted);
    setIsMicMuted(nextMuted);
  }, [daily, isMicMuted]);

  // ---------------------------------------------------------------------------
  // Readiness polling + activation
  // Purpose: keep loading UI in sync with Akapulu setup milestones.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!conversationSessionId || status !== "connecting" || callIsReady) return;
    let isCancelled = false;

    const pollUpdates = async () => {
      if (isCancelled || status !== "connecting" || callIsReady) return;
      // Poll local `/api/demo` updates route while connecting.
      // The route proxies to Akapulu `/conversations/<id>/updates/`.
      const response = await fetch(`/api/demo?conversation_session_id=${conversationSessionId}`);
      if (!response.ok) {
        // Retry quickly on transient failures to keep loading resilient.
        if (!isCancelled) window.setTimeout(pollUpdates, 200);
        return;
      }
      const payload = await response.json();
      const nextCallIsReady = payload?.call_is_ready === true;
      // Clamp to [0, 100] to keep the progress bar stable.
      const nextCompletionPercent =
        typeof payload?.completion_percent === "number" && Number.isFinite(payload.completion_percent)
          ? Math.max(0, Math.min(100, payload.completion_percent))
          : 0;
      const nextLatestUpdateText =
        typeof payload?.latest_update_text === "string" && payload.latest_update_text.trim() !== ""
          ? payload.latest_update_text
          : "Initializing conversation...";
      if (!isCancelled) {
        // Readiness and progress come from backend milestones directly.
        setCallIsReady(nextCallIsReady);
        setCompletionPercent(nextCompletionPercent);
        setLatestUpdateText(nextLatestUpdateText);
        if (!nextCallIsReady) {
          // 200ms keeps progress responsive without excessive request volume.
          window.setTimeout(pollUpdates, 200);
        }
      }
    };

    pollUpdates();
    return () => {
      isCancelled = true;
    };
  }, [conversationSessionId, status, callIsReady]);

  // Flip connecting -> connected once backend reports call_is_ready.
  useEffect(() => {
    if (status !== "connecting") return;
    if (callIsReady) setStatus("connected");
  }, [status, callIsReady]);

  // Optional recording strategy: start once setup crosses 50%.
  useEffect(() => {
    if (!daily) return;
    if (completionPercent < 50) return;
    if (recordingStartRequestedRef.current) return;

    const startRecording = (daily as any).startRecording;
    if (typeof startRecording !== "function") {
      // Older SDK/call-object variants may not expose recording APIs.
      console.error("[recording] startRecording is unavailable on Daily call object");
      return;
    }

    recordingStartRequestedRef.current = true;
    Promise.resolve(startRecording.call(daily, { type: "cloud" }))
      .then(() => {
        // recording started
      })
      .catch((error: unknown) => {
        console.error("[recording] start request failed", error);
        recordingStartRequestedRef.current = false;
      });
  }, [daily, completionPercent]);

  // Auto-end when the remote participant leaves.
  useEffect(() => {
    if (!daily || status !== "connected") return;
    const handleParticipantLeft = (participant: any) => {
      if (participant && !participant.info?.isLocal) {
        endCall();
      }
    };
    daily.on("participant-left", handleParticipantLeft);
    return () => {
      daily.off("participant-left", handleParticipantLeft);
    };
  }, [daily, status, endCall]);

  // ---------------------------------------------------------------------------
  // Pipecat RTVI subscriptions
  // Transcript events + server message events drive most live UI updates.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!client) return;

    // User transcript can be partial/final. Replace the active partial row until final.
    // This avoids flashing a new row on every partial token.
    const handleUserTranscript = (transcript: { text?: string; final?: boolean }) => {
      const isFinal = transcript.final || false;
      const newText = transcript.text || "";
      setTranscripts((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.speaker === "user" && !last.isFinal) {
          // Mutate-in-place behavior (via copy) keeps one row for streaming text.
          const next = [...prev];
          next[next.length - 1] = { ...last, text: newText, isFinal, timestamp: new Date() };
          return next;
        }
        return [...prev, { id: `user-${Date.now()}`, text: newText, speaker: "user", timestamp: new Date(), isFinal }];
      });
    };

    // Bot transcript arrives in chunks; append chunks to the current bot row.
    // UX intent: make bot responses feel continuous rather than fragmented.
    const handleBotTranscript = (transcript: { text?: string }) => {
      const newText = transcript.text || "";
      setTranscripts((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.speaker === "bot" && !last.isFinal) {
          // Concatenate incremental bot text until the row is marked final.
          const next = [...prev];
          next[next.length - 1] = { ...last, text: `${last.text}${newText}`, timestamp: new Date() };
          return next;
        }
        return [...prev, { id: `bot-${Date.now()}`, text: newText, speaker: "bot", timestamp: new Date(), isFinal: false }];
      });
    };

    const handleServerMessage = (message: any) => {
      // Bot speaking state can be "speaking" or "idle".
      if (message?.type === "bot-speaking-state") {
        const nextState = message?.state === "speaking" ? "speaking" : "idle";
        setBotSpeakingState(nextState);
        return;
      }

      // Flow-node transition updates current stage UI and closes active bot row.
      if (message?.type === "flow-node-changed") {
        // Finalize active bot row when node changes to avoid text bleeding across stages.
        setCurrentStage(message?.node || null);
        setCurrentStageColor(getCycledStageColor(stageColorIndexRef.current));
        stageColorIndexRef.current += 1;
        setTranscripts((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.speaker !== "bot" || last.isFinal) return prev;
          const next = [...prev];
          next[next.length - 1] = { ...last, isFinal: true };
          return next;
        });
        return;
      }

      const messageType = message?.type || "";
      const isToolEvent = messageType === "RAG" || messageType === "vision" || messageType === "http";
      if (!isToolEvent) return;

      // Normalize supported tool messages into one toast model for display.
      const functionName = message?.function_name || "unknown_function";
      const rawBody = typeof message?.body === "object" && message?.body !== null ? message.body : {};
      let args: Array<{ key: string; value: string }> | undefined;
      let summary = "Tool called";
      let query: string | undefined;
      let argsJson: string | undefined;

      if (messageType === "RAG") {
        // For RAG, surface the query string prominently.
        summary = "RAG tool called";
        const queryValue = (rawBody as Record<string, unknown>).query;
        if (queryValue !== undefined && queryValue !== null && String(queryValue) !== "") {
          query = formatToolArgValue(queryValue);
        }
      } else if (messageType === "http") {
        // For HTTP tools, show full argument JSON for debugging.
        summary = "HTTP endpoint called";
        argsJson = JSON.stringify(rawBody, null, 2);
      } else if (messageType === "vision") {
        summary = "Vision tool called";
      }

      setFunctionCallToast({ messageType, functionName, summary, query, args, argsJson });
      if (functionToastTimeoutRef.current !== null) {
        window.clearTimeout(functionToastTimeoutRef.current);
      }
      // Keep only the most recent tool call toast visible.
      functionToastTimeoutRef.current = window.setTimeout(() => setFunctionCallToast(null), 4000);
    };

    const handleUserStartedSpeaking = () => {
      setBotSpeakingState("listening");
    };

    client.on(RTVIEvent.UserTranscript, handleUserTranscript);
    client.on(RTVIEvent.BotTranscript, handleBotTranscript);
    client.on(RTVIEvent.ServerMessage, handleServerMessage);
    client.on(RTVIEvent.UserStartedSpeaking, handleUserStartedSpeaking);

    return () => {
      client.off(RTVIEvent.UserTranscript, handleUserTranscript);
      client.off(RTVIEvent.BotTranscript, handleBotTranscript);
      client.off(RTVIEvent.ServerMessage, handleServerMessage);
      client.off(RTVIEvent.UserStartedSpeaking, handleUserStartedSpeaking);
      if (functionToastTimeoutRef.current !== null) {
        window.clearTimeout(functionToastTimeoutRef.current);
      }
    };
  }, [client]);

  const progressPercent = completionPercent;
  // Partial user transcripts can arrive while the bot has joined but the call is
  // still initializing, so hide user rows until the first bot utterance for cleaner UX.
  const hasBotSpoken = transcripts.some((entry) => entry.speaker === "bot" && entry.text.trim() !== "");
  const visibleTranscripts = hasBotSpoken ? transcripts : transcripts.filter((entry) => entry.speaker !== "user");

  // ---------------------------------------------------------------------------
  // UI states: idle -> connecting (progress) -> connected (live call)
  // ---------------------------------------------------------------------------
  return (
    <>
      <style>{pulseKeyframes}</style>

      {/* Tool activity toast (RAG/vision/http) */}
      {functionCallToast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            width: "min(460px, calc(100vw - 32px))",
            borderRadius: 12,
            border: TOOL_THEME[functionCallToast.messageType]?.border || "1px solid rgba(56,189,248,0.35)",
            background: "linear-gradient(180deg, rgba(15,23,42,0.96) 0%, rgba(2,6,23,0.96) 100%)",
            boxShadow: "0 18px 36px rgba(0,0,0,0.45)",
            zIndex: 1200,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderBottom:
                functionCallToast.messageType === "vision"
                  ? "none"
                  : "1px solid rgba(51,65,85,0.9)",
              background: "rgba(15,23,42,0.85)",
              fontSize: 13,
              color: TOOL_THEME[functionCallToast.messageType]?.title || "#7dd3fc",
              fontWeight: 800,
              letterSpacing: "0.02em",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {TOOL_ICON[functionCallToast.messageType as keyof typeof TOOL_ICON] || null}
              {functionCallToast.summary}
            </div>
            {functionCallToast.messageType !== "vision" && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0,
                  border: "1px solid rgba(100,116,139,0.35)",
                  borderRadius: 999,
                  padding: "4px 8px",
                  background: "rgba(2,6,23,0.5)",
                  maxWidth: "100%",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#e2e8f0",
                    overflowWrap: "anywhere",
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                >
                  {functionCallToast.functionName}
                </span>
              </div>
            )}
          </div>
          {functionCallToast.messageType !== "vision" && (
            <div style={{ padding: 12, display: "grid", gap: 8 }}>
              <>
                {functionCallToast.messageType === "RAG" && functionCallToast.query && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "96px minmax(0, 1fr)",
                      gap: 8,
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: "#64748b", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", lineHeight: 1.45 }}>
                      QUERY
                    </span>
                    <span
                      style={{
                        color: "#e2e8f0",
                        fontSize: 12,
                        lineHeight: 1.45,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {functionCallToast.query}
                    </span>
                  </div>
                )}

                {functionCallToast.messageType === "http" && functionCallToast.argsJson && (
                  <>
                    <div style={{ color: "#64748b", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                      ARGUMENTS
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        border: "1px solid rgba(100,116,139,0.22)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        background: "rgba(2,6,23,0.45)",
                        color: "#cbd5e1",
                        fontSize: 12,
                        lineHeight: 1.45,
                        overflowX: "auto",
                        maxHeight: 220,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      }}
                    >
                      {functionCallToast.argsJson}
                    </pre>
                  </>
                )}
              </>
            </div>
          )}
        </div>
      )}

      <div className={styles.content}>
        <h1 className={styles.title}>{DEMO_PAGE_TITLE}</h1>

        {/* Idle: waiting for user to start a session */}
        {status === "idle" && (
          <button className={styles.button} onClick={startCall}>
            Start Call
          </button>
        )}

        {/* Connect error modal from setup/join flow */}
        {connectError && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connection error"
            onClick={() => {
              setConnectError(null);
              setConnectErrorCode(null);
            }}
            style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.55)", display: "grid", placeItems: "center", zIndex: 2000, padding: 16 }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{ width: "100%", maxWidth: 500, minHeight: 300, borderRadius: 12, border: "1px solid rgba(239, 68, 68, 0.45)", background: "#151515", color: "#f3f4f6", padding: 24, display: "flex", flexDirection: "column", textAlign: "center" }}
            >
              <div style={{ display: "grid", justifyItems: "center", alignContent: "start", gap: 8 }}>
                <h3 style={{ margin: 0, color: "#f87171" }}>Connection failed</h3>
                {connectErrorCode && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "#94a3b8",
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    }}
                  >
                    Code: {connectErrorCode}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, display: "grid", placeItems: "center", padding: "12px 0" }}>
                <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.45, maxWidth: 760 }}>{connectError}</p>
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button
                  className={styles.button}
                  onClick={() => {
                    setConnectError(null);
                    setConnectErrorCode(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Connecting: setup progress from conversation updates API */}
        {status === "connecting" && (
          <div style={{ width: "100%", maxWidth: "500px", marginInline: "auto" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 14, minHeight: 120 }}>
              <div style={{ width: 56, height: 56, border: "5px solid #60a5fa", borderTopColor: "transparent", borderRadius: "999px", animation: "spin 0.9s linear infinite" }} />
              <span style={{ color: "#d1d5db", fontSize: 17, fontWeight: 600 }}>Connecting...</span>
            </div>
            <div style={{ width: "100%", height: 12, borderRadius: 999, background: "#2a2a2a", overflow: "hidden" }}>
              <div style={{ width: `${progressPercent}%`, height: "100%", background: "linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)", transition: "width 320ms ease-in-out" }} />
            </div>
            <div style={{ marginTop: 10, color: "#9ca3af", fontSize: 13 }}>{latestUpdateText}</div>
          </div>
        )}

        {/* Connected: Daily media + transcript/stage view for the live session */}
        {status === "connected" && (
          <div className={`${styles.connectedLayout} ${VOICE_ONLY_MODE ? styles.voiceOnlyLayout : ""}`}>
            {/* Video-first layout for avatar + local PIP */}
            {!VOICE_ONLY_MODE && (
              <div className={styles.videoPane}>
                <div className={styles.videoSurface}>
                  {remoteParticipantIds.length > 0 ? (
                    <VideoTile id={remoteParticipantIds[0]} isLocal={false} />
                  ) : localParticipantId !== "" ? (
                    <VideoTile id={localParticipantId} isLocal />
                  ) : (
                    <div style={{ width: "100%", background: "#232323", color: "#9ca3af", padding: "2rem 1rem", textAlign: "center" }}>
                      Waiting for video...
                    </div>
                  )}
                </div>
                <div
                  className={`${styles.botStateBadge} ${
                    botSpeakingState === "speaking"
                      ? styles.botStateSpeaking
                      : botSpeakingState === "listening"
                        ? styles.botStateListening
                        : styles.botStateIdle
                  }`}
                >
                  {botSpeakingState === "speaking"
                    ? "Speaking"
                    : botSpeakingState === "listening"
                      ? "Listening"
                      : "Idle"}
                </div>

                {localParticipant && (
                  <div className={styles.pip}>
                    <VideoTile id={localParticipant.session_id} isLocal />
                  </div>
                )}

                <button
                  onClick={toggleMute}
                  aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                  title={isMicMuted ? "Unmute" : "Mute"}
                  className={styles.callControl}
                  style={{ left: "1rem", backgroundColor: isMicMuted ? "rgba(239,68,68,0.92)" : "rgba(17,24,39,0.88)" }}
                >
                  {isMicMuted ? <MicOff size={19} strokeWidth={2.2} /> : <Mic size={19} strokeWidth={2.2} />}
                </button>
                <button
                  onClick={endCall}
                  aria-label="Leave call"
                  title="Leave call"
                  className={styles.callControl}
                  style={{ left: "4.5rem" }}
                >
                  <PhoneOff size={19} strokeWidth={2.2} />
                </button>
              </div>
            )}

            {/* Voice-only mode: controls + transcript without video tiles */}
            {VOICE_ONLY_MODE && (
              <div className={styles.voiceOnlyControls}>
                <button
                  onClick={toggleMute}
                  aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                  title={isMicMuted ? "Unmute" : "Mute"}
                  className={styles.voiceOnlyControlButton}
                  style={{ backgroundColor: isMicMuted ? "rgba(239,68,68,0.92)" : "rgba(17,24,39,0.88)" }}
                >
                  {isMicMuted ? <MicOff size={19} strokeWidth={2.2} /> : <Mic size={19} strokeWidth={2.2} />}
                </button>
                <button
                  onClick={endCall}
                  aria-label="Leave call"
                  title="Leave call"
                  className={styles.voiceOnlyControlButton}
                  style={{ backgroundColor: "rgba(185,28,28,0.9)" }}
                >
                  <PhoneOff size={19} strokeWidth={2.2} />
                </button>
              </div>
            )}

            {/* Transcript plus current flow-node stage indicator */}
            <div className={`${styles.transcriptPane} ${VOICE_ONLY_MODE ? styles.voiceOnlyTranscriptPane : ""}`}>
              {/* Transcript stays visible in both voice-only and video layouts. */}
              <div className={`${styles.transcriptContainer} ${VOICE_ONLY_MODE ? styles.voiceOnlyTranscriptContainer : ""}`} ref={transcriptRef}>
                <div className={styles.transcriptHeader}>
                  <h3>Transcript</h3>
                  {currentStage && (
                    <div className={styles.stageChip} style={{ border: `1px solid ${currentStageColor}`, color: currentStageColor }}>
                      <span className={styles.stageDot} style={{ backgroundColor: currentStageColor }} />
                      <span>{currentStage.replace(/_/g, " ")}</span>
                    </div>
                  )}
                </div>
                {visibleTranscripts.map((entry) => (
                  <div key={entry.id} className={entry.speaker === "user" ? styles.userTranscript : styles.botTranscript}>
                    <span className={styles.speaker}>{entry.speaker === "user" ? "You" : "Bot"}:</span>
                    <span className={styles.text}>
                      {entry.text}
                      {!entry.isFinal && entry.speaker === "user" && "..."}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default function DemoPage() {
  // Build one shared Pipecat client instance after mount.
  const [client, setClient] = useState<PipecatClient | null>(null);

  useEffect(() => {
    // Pipecat client is the app-level API.
    // DailyTransport is the media layer plugged into that client.
    const nextClient = new PipecatClient({
      transport: new DailyTransport(),
      enableMic: true,
      enableCam: !VOICE_ONLY_MODE,
    });
    setClient(nextClient);
  }, []);

  if (!client) {
    // Prevent rendering provider tree until transport/client objects exist.
    return (
      <main className={styles.container} style={{ display: "grid", placeItems: "center" }}>
        <p>Loading...</p>
      </main>
    );
  }

  // Read Daily call object from transport so DailyProvider hooks can work.
  const dailyCallClient = (client.transport as DailyTransport)?.dailyCallClient;

  return (
    <main className={styles.container}>
      {/* Pipecat provider gives CustomRtviDemo access to realtime client APIs. */}
      <PipecatClientProvider client={client}>
        {dailyCallClient ? (
          // DailyProvider supplies media + participant context to Daily hooks.
          <DailyProvider callObject={dailyCallClient as any}>
            {/*  We can now access client and daily call object from the CustomRtviDemo component. */}
            <CustomRtviDemo />
          </DailyProvider>
        ) : (
          // Fallback render if Daily call object is unavailable.
          <CustomRtviDemo />
        )}
        {/* Assistant audio playback element from Pipecat React package. */}
        <PipecatClientAudio />
      </PipecatClientProvider>
    </main>
  );
}
