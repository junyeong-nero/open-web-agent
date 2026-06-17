from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _common.protocol import call_model, emit_response, format_observation, normalize_decision, parse_json_object, read_request


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

    events = []
    if not state.get("steps"):
        plan = create_plan(state, None)
        events.append({"type": "plan.created", "payload": {"items": plan["items"]}})
    elif last_step_failed(state):
        plan = create_plan(state, "The previous browser action failed. Replan before continuing.")
        events.append({"type": "plan.updated", "payload": {"items": plan["items"], "reason": "browser_action_failed"}})

    decision = choose_decision(state)
    emit_response({"events": events, "decision": decision})


def create_plan(state, reason):
    response = call_model(build_plan_request(state, reason), "plan_1")
    plan = parse_json_object(response.get("text") or "", "plan")
    items = plan.get("items")
    if not isinstance(items, list) or not items:
        raise RuntimeError("Plan response must contain non-empty items")
    return {"items": items}


def choose_decision(state):
    last_error = None
    last_raw = ""

    for attempt in range(2):
        response = call_model(build_decision_request(state, last_error, last_raw), f"decision_{attempt + 1}")
        last_raw = response.get("text") or ""
        try:
            decision = parse_json_object(last_raw, "decision")
            if decision.get("type") not in ("browser_actions", "final_answer"):
                raise RuntimeError("Decision type must be browser_actions or final_answer")
            return normalize_decision(decision)
        except RuntimeError as error:
            last_error = str(error)

    raise RuntimeError(f"Invalid model decision after retry. Raw output: {last_raw}")


def build_plan_request(state, reason):
    content = [
        f"Task: {state.get('prompt') or ''}",
        "",
        "Current observation:",
        format_observation(state.get("lastObservation")),
        "",
        f"Completed steps: {len(state.get('steps') or [])}",
    ]
    if reason:
        content.extend(["", f"Planning reason: {reason}"])

    failed_results = failed_action_messages(state)
    if failed_results:
        content.extend(["", "Failed browser results:", "\n".join(failed_results)])

    return {
        "model": "",
        "temperature": 0,
        "responseFormat": "json",
        "messages": [
            {
                "role": "system",
                "content": "\n".join(
                    [
                        "You are Open Web Agent's planning agent.",
                        "Return only JSON with this shape:",
                        '{"items":[{"id":string,"title":string,"status":"pending"|"active"|"completed"}]}',
                        "Use concise user-visible task titles.",
                    ]
                ),
            },
            {"role": "user", "content": "\n".join(content)},
        ],
    }


def build_decision_request(state, last_error, last_raw):
    content = [
        f"Task: {state.get('prompt') or ''}",
        "",
        "Current observation:",
        format_observation(state.get("lastObservation")),
        "",
        f"Completed steps: {len(state.get('steps') or [])}",
    ]
    if last_error:
        content.extend(["", f"Previous response was invalid: {last_error}", "Raw response:", last_raw, "Return corrected JSON only."])

    return {
        "model": "",
        "temperature": 0,
        "responseFormat": "json",
        "messages": [
            {
                "role": "system",
                "content": "\n".join(
                    [
                        "You are Open Web Agent's browser-control agent.",
                        "Return only JSON matching one of these shapes:",
                        '{"type":"browser_actions","thought":string|null,"actions":[{"id":string,"kind":string,"reason":string|null,"requiresApproval":boolean,"toolCalls":[...]}]}',
                        '{"type":"final_answer","thought":string|null,"finalAnswer":string,"confidence":number|null}',
                        "Browser tool calls must be nested under browser_actions.actions[].toolCalls.",
                    ]
                ),
            },
            {"role": "user", "content": "\n".join(content)},
        ],
    }


def last_step_failed(state):
    steps = state.get("steps") or []
    if not steps:
        return False
    return any(not result.get("ok") for result in steps[-1].get("actionResults") or [])


def failed_action_messages(state):
    messages = []
    for step in state.get("steps") or []:
        for result in step.get("actionResults") or []:
            if not result.get("ok"):
                messages.append(result.get("message") or "Browser action failed")
    return messages


if __name__ == "__main__":
    main()
