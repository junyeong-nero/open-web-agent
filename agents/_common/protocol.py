import json
import sys


def read_request():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Missing lifecycle request")
    return json.loads(line)


def emit_response(response):
    print(json.dumps(response), flush=True)


def call_model(request, command_id):
    emit_response({"command": "model.complete", "id": command_id, "request": request})
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError(f"Missing model response for {command_id}")

    response = json.loads(line)
    if not response.get("ok"):
        raise RuntimeError(response.get("error") or f"Model command {command_id} failed")
    return response["response"]


def format_observation(observation):
    if not observation:
        return "No browser observation has been captured yet."

    elements = []
    for index, element in enumerate((observation.get("interactiveElements") or [])[:20], start=1):
        elements.append(
            " ".join(
                [
                    f"{index}. id={element.get('id') or ''}",
                    f"role={element.get('role') or ''}",
                    f"name={element.get('name') or ''}",
                    f"text={element.get('text') or ''}",
                    f"selector={element.get('selector') or ''}",
                ]
            )
        )

    return "\n".join(
        [
            f"URL: {observation.get('url') or ''}",
            f"Title: {observation.get('title') or ''}",
            "Text:",
            observation.get("text") or "",
            "Interactive elements:",
            "\n".join(elements) if elements else "None",
        ]
    )


def parse_json_object(text, label):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Model returned invalid {label} JSON: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Model returned non-object {label} JSON")
    return value


def normalize_decision(value):
    if not isinstance(value, dict) or value.get("type") != "browser_actions":
        return value

    actions = value.get("actions")
    if not isinstance(actions, list):
        return value

    normalized_actions = []
    for action_index, action in enumerate(actions, start=1):
        if not isinstance(action, dict):
            normalized_actions.append(action)
            continue

        action_id = action.get("id") or f"action_{action_index}"
        tool_calls = []
        for tool_index, tool_call in enumerate(action.get("toolCalls") or [], start=1):
            tool_calls.append(normalize_tool_call(tool_call, action_id, tool_index))

        normalized = dict(action)
        normalized["id"] = action_id
        normalized["requiresApproval"] = bool(normalized.get("requiresApproval", False))
        normalized["toolCalls"] = tool_calls
        normalized_actions.append(normalized)

    result = dict(value)
    result["actions"] = normalized_actions
    return result


def normalize_tool_call(tool_call, action_id, tool_index):
    if not isinstance(tool_call, dict):
        return tool_call

    args = tool_call.get("arguments") if isinstance(tool_call.get("arguments"), dict) else {}
    if not args and isinstance(tool_call.get("args"), dict):
        args = tool_call["args"]

    normalized = {**args, **tool_call}
    normalized.pop("arguments", None)
    normalized.pop("args", None)

    if not isinstance(normalized.get("type"), str):
        if isinstance(normalized.get("name"), str):
            normalized["type"] = normalized["name"]
        elif isinstance(normalized.get("kind"), str):
            normalized["type"] = normalized["kind"]
    normalized.pop("name", None)
    normalized.pop("kind", None)

    if "target" not in normalized and isinstance(normalized.get("ref"), str) and normalized["ref"]:
        normalized["target"] = {"selector": selector_for_ref(normalized["ref"])}
    normalized.pop("ref", None)

    if normalized.get("type") == "type" and not isinstance(normalized.get("value"), str):
        if isinstance(normalized.get("text"), str):
            normalized["value"] = normalized["text"]
    if normalized.get("type") != "final_answer":
        normalized.pop("text", None)

    if not isinstance(normalized.get("id"), str) or not normalized["id"]:
        normalized["id"] = f"{action_id}_tool_{tool_index}"

    return normalized


def selector_for_ref(ref):
    if ref.startswith("#") or ref.startswith(".") or ref.startswith("["):
        return ref
    return f"#{ref}"
