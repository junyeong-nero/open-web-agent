import json
import sys


def main() -> None:
    request = json.load(sys.stdin)
    method = request.get("method")

    if method == "initialize":
        print(json.dumps({"ok": True}))
        return

    state = request.get("state") or {}

    if method == "finalize":
        print(json.dumps({"finalAnswer": state.get("finalAnswer") or ""}))
        return

    if method != "step":
        raise SystemExit(f"Unsupported method: {method}")

    observation = state.get("lastObservation") or {}
    text = observation.get("text")
    screenshot_path = observation.get("screenshotPath")

    if not text or not screenshot_path:
        print(
            json.dumps(
                {
                    "events": [
                        {
                            "type": "plan.created",
                            "payload": {
                                "items": [
                                    {
                                        "id": "open-page",
                                        "title": "Open the page",
                                        "status": "active",
                                    },
                                    {
                                        "id": "ground-text",
                                        "title": "Extract text grounding",
                                        "status": "pending",
                                    },
                                    {
                                        "id": "ground-vision",
                                        "title": "Capture screenshot grounding",
                                        "status": "pending",
                                    },
                                ]
                            },
                        }
                    ],
                    "decision": {
                        "type": "browser_actions",
                        "thought": "Need both extracted text and a screenshot artifact before answering.",
                        "actions": [
                            {
                                "id": "mixed_grounding_observe",
                                "kind": "mixed_grounding_observe",
                                "reason": "Collect text and screenshot grounding from the browser runtime.",
                                "requiresApproval": False,
                                "toolCalls": [
                                    {
                                        "id": "navigate_example",
                                        "type": "navigate",
                                        "url": "https://example.com",
                                    },
                                    {
                                        "id": "capture_screenshot",
                                        "type": "screenshot",
                                    },
                                    {
                                        "id": "extract_text",
                                        "type": "extract_text",
                                    },
                                ],
                            }
                        ],
                    },
                }
            )
        )
        return

    title = observation.get("title") or text.splitlines()[0]
    print(
        json.dumps(
            {
                "events": [
                    {
                        "type": "plan.updated",
                        "payload": {
                            "items": [
                                {
                                    "id": "open-page",
                                    "title": "Open the page",
                                    "status": "completed",
                                },
                                {
                                    "id": "ground-text",
                                    "title": "Extract text grounding",
                                    "status": "completed",
                                },
                                {
                                    "id": "ground-vision",
                                    "title": "Capture screenshot grounding",
                                    "status": "completed",
                                },
                            ],
                            "reason": "mixed_grounding_complete",
                        },
                    }
                ],
                "decision": {
                    "type": "final_answer",
                    "thought": "The answer is grounded by extracted text and the screenshot artifact path.",
                    "finalAnswer": f'text grounding found title "{title}"; vision grounding used screenshot artifact {screenshot_path}.',
                    "confidence": 1,
                },
            }
        )
    )


if __name__ == "__main__":
    main()
