import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request


"""
Simple Assistant (CLI)
----------------------
This script does three things:

1) Calls the Akapulu connect endpoint for a scenario.
2) Polls conversation updates until the bot is ready.
3) Prints a tokenized Daily URL that can be opened directly.
"""


API_BASE_URL = "https://akapulu.com/api"
CONNECT_PATH = "/conversations/connect/"
POLL_INTERVAL_SECONDS = 0.5
READY_DESCRIPTION = "bot ready"
DEFAULT_AVATAR_ID = "d20e3ec3-b713-4e5e-aa5b-02f09031a339"


def post_connect(api_key, scenario_id, avatar_id):
    # Build and send the initial "connect" request.
    # This allocates a conversation session and returns room/token info.
    url = f"{API_BASE_URL}{CONNECT_PATH}"

    body = {
        "scenario_id": scenario_id,
        "avatar_id": avatar_id,
        "runtime_vars": {},
        "voice_only_mode": False,
        "custom_rtvi_connection": False,
    }

    data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    response = urllib.request.urlopen(request)
    payload = json.loads(response.read().decode("utf-8"))

    return response.status, payload


def get_updates(api_key, conversation_session_id):
    # Poll conversation status updates for the current session.
    # Backend returns: call_is_ready, completion_percent, latest_update_text.
    url = f"{API_BASE_URL}/conversations/{conversation_session_id}/updates/"

    request = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
    )

    response = urllib.request.urlopen(request)
    payload = json.loads(response.read().decode("utf-8"))

    return response.status, payload


def main():
    # -----------------------------
    # Parse required CLI arguments.
    # -----------------------------
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario-id", required=True, help="Scenario ID to run")
    parser.add_argument(
        "--avatar-id",
        default=DEFAULT_AVATAR_ID,
        help=f"Avatar UUID to run (default: {DEFAULT_AVATAR_ID})",
    )

    args = parser.parse_args()
    scenario_id = args.scenario_id.strip()
    avatar_id = args.avatar_id.strip()
    api_key = (os.environ.get("AKAPULU_API_KEY") or "").strip()

    # -------------------------------------------------
    # Validate required inputs before making API calls.
    # -------------------------------------------------
    if scenario_id == "":
        print("Error: scenario_id is required")
        sys.exit(1)

    if avatar_id == "":
        print("Error: avatar_id is required")
        sys.exit(1)

    if api_key == "":
        print("Error: set AKAPULU_API_KEY in your environment")
        sys.exit(1)

    # -------------------------------------
    # Start a new conversation via backend.
    # -------------------------------------
    status, connect_payload = post_connect(api_key, scenario_id, avatar_id)
    if status != 200:
        print("Connect failed:")
        print(json.dumps(connect_payload, indent=2))
        sys.exit(1)

    # Required outputs from connect payload.
    conversation_session_id = connect_payload["conversation_session_id"]
    room_url = connect_payload["room_url"]
    token = connect_payload.get("token", "")

    # For private Daily rooms, direct browser opens must include token query param.
    # If token is present, build a URL like:
    #   https://<room>.daily.co/<room-name>?t=<token>
    tokenized_room_url = room_url
    if isinstance(token, str) and token.strip() != "":
        separator = "&" if "?" in room_url else "?"
        tokenized_room_url = f"{room_url}{separator}{urllib.parse.urlencode({'t': token})}"

    print(f"conversation_session_id: {conversation_session_id}")
    print("Polling updates...")

    # Track the last printed update to avoid duplicate lines.
    last_update_text = ""
    ready = False

    # Simple text-based loading animation.
    dot_frames = [".", "..", "..."]
    dot_idx = 0

    # --------------------------------------------
    # Poll until backend says the bot is "ready".
    # --------------------------------------------
    while not ready:
        updates_status, updates_payload = get_updates(api_key, conversation_session_id)
        if updates_status != 200:
            print("Updates request failed:")
            print(json.dumps(updates_payload, indent=2))
            sys.exit(1)

        # latest_update_text is the human-readable setup milestone.
        latest_update_text = (updates_payload.get("latest_update_text") or "").strip()

        # Print each milestone once.
        if latest_update_text and latest_update_text != last_update_text:
            print(f"✅ update: {latest_update_text}")
            last_update_text = latest_update_text

        # Backend readiness key (currently mapped to "bot ready" for this script).
        if latest_update_text == READY_DESCRIPTION:
            print("")
            print("✅ Bot is ready.")
            print("")
            print("")
            print(f"Daily call URL: {tokenized_room_url}")
            ready = True

        # Keep showing plain-text progress while waiting.
        if not ready:
            status_line = latest_update_text if latest_update_text else "waiting for bot readiness updates"
            dots = dot_frames[dot_idx % len(dot_frames)]
            dot_idx += 1
            print(f"waiting{dots} ({status_line})")
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
