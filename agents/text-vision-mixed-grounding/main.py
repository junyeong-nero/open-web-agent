from pathlib import Path
import base64
import mimetypes
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _common.protocol import call_model, emit_response, read_request


URL_RE = re.compile(r"https?://[^\s)>,]+", re.IGNORECASE)
DOMAIN_RE = re.compile(r"\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:/[^\s)>,]+)?")


def main():
    request = read_request()
    method = request.get("method")

    if method == "initialize":
        emit_response({"ok": True})
        return

    state = request.get("state") or {}
    if method == "finalize":
        emit_response({"finalAnswer": state.get("finalAnswer") or ""})
        return

    if method != "step":
        raise SystemExit(f"Unsupported method: {method}")

    observation = state.get("lastObservation") or {}
    text = observation.get("text")
    screenshot_path = observation.get("screenshotPath")

    if not text or not screenshot_path:
        emit_response(build_observation_decision(state, observation, bool(text), bool(screenshot_path)))
        return

    data_url = screenshot_data_url(screenshot_path)
    response = call_model(build_grounding_request(state, observation, data_url), "grounding_1")
    answer = response.get("text") or "The selected model returned an empty grounding answer."
    emit_response(
        {
            "events": [
                {
                    "type": "plan.updated",
                    "payload": {
                        "items": [
                            {"id": "open-page", "title": "Open the target page", "status": "completed"},
                            {"id": "ground-text", "title": "Use extracted text", "status": "completed"},
                            {"id": "ground-vision", "title": "Use screenshot image", "status": "completed"},
                        ],
                        "reason": "mixed_grounding_model_complete",
                    },
                }
            ],
            "decision": {
                "type": "final_answer",
                "thought": "The answer comes from the selected model using extracted text and screenshot content.",
                "finalAnswer": answer,
                "confidence": 1,
            },
        }
    )


def build_observation_decision(state, observation, has_text, has_screenshot):
    prompt = state.get("prompt") or ""
    current_url = observation.get("url") or "about:blank"
    target_url = extract_target_url(prompt)
    tool_calls = []

    if current_url == "about:blank":
        if not target_url:
            return {
                "decision": {
                    "type": "final_answer",
                    "thought": "A page URL is required before text and vision grounding can run.",
                    "finalAnswer": "Please include a URL or domain so I can capture text and screenshot grounding.",
                    "confidence": 0.2,
                }
            }
        tool_calls.append({"id": "navigate_target", "type": "navigate", "url": target_url})

    if not has_screenshot:
        tool_calls.append({"id": "capture_screenshot", "type": "screenshot"})
    if not has_text:
        tool_calls.append({"id": "extract_text", "type": "extract_text"})

    return {
        "events": [
            {
                "type": "plan.created",
                "payload": {
                    "items": [
                        {
                            "id": "open-page",
                            "title": "Open the target page",
                            "status": "active" if current_url == "about:blank" else "completed",
                        },
                        {
                            "id": "ground-text",
                            "title": "Use extracted text",
                            "status": "completed" if has_text else "pending",
                        },
                        {
                            "id": "ground-vision",
                            "title": "Use screenshot image",
                            "status": "completed" if has_screenshot else "pending",
                        },
                    ]
                },
            }
        ],
        "decision": {
            "type": "browser_actions",
            "thought": "Need extracted text and a screenshot artifact before the model can ground the answer.",
            "actions": [
                {
                    "id": "mixed_grounding_observe",
                    "kind": "mixed_grounding_observe",
                    "reason": "Collect browser text and screenshot content for model grounding.",
                    "requiresApproval": False,
                    "toolCalls": tool_calls,
                }
            ],
        },
    }


def build_grounding_request(state, observation, data_url):
    text = observation.get("text") or ""
    title = observation.get("title") or ""
    url = observation.get("url") or ""
    prompt = state.get("prompt") or ""

    return {
        "model": "",
        "temperature": 0,
        "responseFormat": "text",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are Open Web Agent's mixed grounding agent. "
                    "Answer the user's task using both extracted page text and the screenshot image. "
                    "Be concise and do not mention file paths."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "\n".join(
                            [
                                f"Task: {prompt}",
                                f"URL: {url}",
                                f"Title: {title}",
                                "",
                                "Extracted text:",
                                text,
                            ]
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    }


def screenshot_data_url(path):
    screenshot_path = Path(path)
    media_type = mimetypes.guess_type(screenshot_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(screenshot_path.read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def extract_target_url(prompt):
    match = URL_RE.search(prompt)
    if match:
        return strip_trailing_punctuation(match.group(0))

    match = DOMAIN_RE.search(prompt)
    if not match:
        return None
    return "https://" + strip_trailing_punctuation(match.group(0))


def strip_trailing_punctuation(value):
    return value.rstrip(".,;:")


if __name__ == "__main__":
    main()
