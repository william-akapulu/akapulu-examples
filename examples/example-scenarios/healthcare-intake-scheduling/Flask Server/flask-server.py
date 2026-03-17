from datetime import datetime
from uuid import uuid4

from flask import Flask, jsonify, request


app = Flask(__name__)


def log_request(endpoint_name: str) -> None:
    print(f"\n--- {endpoint_name} ---")
    print(f"Timestamp: {datetime.utcnow().isoformat()}Z")
    print(f"Method: {request.method}")
    print(f"Path: {request.path}")
    print(f"Headers: {dict(request.headers)}")
    print(f"Query Params: {request.args.to_dict()}")
    print(f"JSON Body: {request.get_json(silent=True)}")


@app.post("/actions/pre")
def pre_action():
    log_request("PRE ACTION")
    return jsonify(
        {
            "ok": True,
            "message": "Pre-action received successfully.",
        }
    )


@app.post("/actions/post")
def post_action():
    log_request("POST ACTION")
    return jsonify(
        {
            "ok": True,
            "message": "Post-action received successfully.",
        }
    )


@app.post("/book-appointment")
def book_appointment():
    log_request("BOOK APPOINTMENT")
    confirmation_id = f"apt_{uuid4().hex[:12]}"
    return jsonify(
        {
            "ok": True,
            "message": "Appointment booked successfully.",
            "appointment_confirmation_id": confirmation_id,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
