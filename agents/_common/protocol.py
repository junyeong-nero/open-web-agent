import json
import math
import sys
from urllib.parse import urlparse


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


def format_browser_tools(tools):
    if not isinstance(tools, list) or not tools:
        return "Available browser tools:\nNone."

    formatted = [format_browser_tool(tool) for tool in tools if isinstance(tool, dict)]
    if not formatted:
        return "Available browser tools:\nNone."
    return "\n".join(["Available browser tools:", *formatted])


def format_browser_tool(tool):
    parameters = tool.get("parameters")
    if isinstance(parameters, list) and parameters:
        parameter_text = "; ".join(format_browser_tool_parameter(parameter) for parameter in parameters if isinstance(parameter, dict))
    else:
        parameter_text = "none"

    example = json.dumps(tool.get("example") or {}, ensure_ascii=False, separators=(",", ":"))
    return "\n".join(
        [
            f"- {tool.get('type') or ''}: {tool.get('description') or ''}",
            f"  Parameters: {parameter_text}",
            f"  Example: {example}",
        ]
    )


def format_browser_tool_parameter(parameter):
    required = "required" if parameter.get("required") else "optional"
    return f"{parameter.get('name') or ''} ({parameter.get('type') or ''}, {required}) - {parameter.get('description') or ''}"


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


def repair_decision_targets(value, observation):
    if not isinstance(value, dict) or value.get("type") != "browser_actions":
        return value
    if not isinstance(observation, dict):
        return value

    actions = value.get("actions")
    if not isinstance(actions, list):
        return value

    repaired_actions = []
    for action in actions:
        if not isinstance(action, dict):
            repaired_actions.append(action)
            continue

        tool_calls = action.get("toolCalls")
        if not isinstance(tool_calls, list):
            repaired_actions.append(action)
            continue

        repaired_action = dict(action)
        repaired_action["toolCalls"] = [repair_tool_call_target(tool_call, observation) for tool_call in tool_calls]
        repaired_actions.append(repaired_action)

    repaired = dict(value)
    repaired["actions"] = repaired_actions
    return repaired


def repair_tool_call_target(tool_call, observation):
    if not isinstance(tool_call, dict) or tool_call.get("type") not in ("click", "type"):
        return tool_call

    target = tool_call.get("target")
    if not isinstance(target, dict):
        return tool_call
    if target_has_executable_locator(target):
        return tool_call

    element_id = target.get("elementId")
    if not isinstance(element_id, str) or not element_id:
        return tool_call

    element = find_observed_element(observation, element_id)
    if not element:
        return tool_call

    repaired_target = dict(target)
    selector = element.get("selector")
    if isinstance(selector, str) and selector:
        repaired_target["selector"] = selector

    if tool_call.get("type") == "click" and not repaired_target.get("selector") and not repaired_target.get("coordinates"):
        coordinates = bounding_box_center(element.get("boundingBox"))
        if coordinates:
            repaired_target["coordinates"] = coordinates

    for key in ("role", "name", "text"):
        if not repaired_target.get(key) and isinstance(element.get(key), str) and element.get(key):
            repaired_target[key] = element[key]

    repaired_tool_call = dict(tool_call)
    repaired_tool_call["target"] = repaired_target
    return repaired_tool_call


def target_has_executable_locator(target):
    return any(bool(target.get(key)) for key in ("selector", "text", "role", "name", "coordinates"))


def find_observed_element(observation, element_id):
    elements = observation.get("interactiveElements")
    if not isinstance(elements, list):
        return None
    for element in elements:
        if isinstance(element, dict) and element.get("id") == element_id:
            return element
    return None


def bounding_box_center(bounding_box):
    if not isinstance(bounding_box, dict):
        return None
    x = bounding_box.get("x")
    y = bounding_box.get("y")
    width = bounding_box.get("width")
    height = bounding_box.get("height")
    if not all(_is_number(value) for value in (x, y, width, height)):
        return None
    return {"x": x + width / 2, "y": y + height / 2}


def validate_agent_decision(value):
    errors = []
    _validate_decision(value, "decision", errors)
    if errors:
        raise RuntimeError("Invalid model decision: " + "; ".join(errors))
    return value


def _validate_decision(value, path, errors):
    if not isinstance(value, dict):
        errors.append(f"{path}: expected object, received {_type_name(value)}")
        return

    decision_type = value.get("type")
    if decision_type == "final_answer":
        _require_optional_string(value, "thought", f"{path}.thought", errors)
        _require_string(value, "finalAnswer", f"{path}.finalAnswer", errors)
        if "confidence" not in value:
            errors.append(f"{path}.confidence: expected number between 0 and 1 or null, received undefined")
            return
        confidence = value.get("confidence")
        if confidence is not None and (not _is_number(confidence) or confidence < 0 or confidence > 1):
            errors.append(f"{path}.confidence: expected number between 0 and 1 or null, received {_type_name(confidence)}")
        return

    if decision_type == "browser_actions":
        _require_optional_string(value, "thought", f"{path}.thought", errors)
        actions = value.get("actions")
        if not isinstance(actions, list):
            errors.append(f"{path}.actions: expected array, received {_type_name(actions)}")
            return
        if not actions:
            errors.append(f"{path}.actions: expected at least one action")
            return
        for action_index, action in enumerate(actions):
            _validate_action(action, f"{path}.actions[{action_index}]", errors)
        return

    errors.append(f"{path}.type: invalid discriminator value; expected browser_actions or final_answer")


def _validate_action(value, path, errors):
    if not isinstance(value, dict):
        errors.append(f"{path}: expected object, received {_type_name(value)}")
        return

    _require_string(value, "id", f"{path}.id", errors)
    _require_string(value, "kind", f"{path}.kind", errors)
    _require_optional_string(value, "reason", f"{path}.reason", errors)
    if not isinstance(value.get("requiresApproval"), bool):
        errors.append(f"{path}.requiresApproval: expected boolean, received {_type_name(value.get('requiresApproval'))}")

    tool_calls = value.get("toolCalls")
    if not isinstance(tool_calls, list):
        errors.append(f"{path}.toolCalls: expected array, received {_type_name(tool_calls)}")
        return
    if not tool_calls:
        errors.append(f"{path}.toolCalls: expected at least one tool call")
        return
    for tool_index, tool_call in enumerate(tool_calls):
        _validate_tool_call(tool_call, f"{path}.toolCalls[{tool_index}]", errors)


def _validate_tool_call(value, path, errors):
    if not isinstance(value, dict):
        errors.append(f"{path}: expected object, received {_type_name(value)}")
        return

    _require_string(value, "id", f"{path}.id", errors)
    tool_type = value.get("type")
    valid_types = {
        "navigate",
        "click",
        "type",
        "scroll",
        "wait",
        "press_key",
        "screenshot",
        "extract_text",
        "go_back",
        "go_forward",
    }
    if tool_type not in valid_types:
        errors.append(
            f"{path}.type: invalid discriminator value; expected "
            + " | ".join(sorted(valid_types))
            + f", received {_type_name(tool_type)}"
        )
        return

    if tool_type == "navigate":
        url = value.get("url")
        if not isinstance(url, str) or not _is_url(url):
            errors.append(f"{path}.url: expected URL string, received {_type_name(url)}")
        return

    if tool_type == "click":
        _require_target(value, path, errors)
        return

    if tool_type == "type":
        _require_target(value, path, errors)
        _require_string(value, "value", f"{path}.value", errors)
        return

    if tool_type == "scroll":
        _require_number(value, "deltaY", f"{path}.deltaY", errors)
        delta_x = value.get("deltaX")
        if delta_x is not None and not _is_number(delta_x):
            errors.append(f"{path}.deltaX: expected number, received {_type_name(delta_x)}")
        return

    if tool_type == "wait":
        ms = value.get("ms")
        if not _is_number(ms):
            errors.append(f"{path}.ms: expected number, received {_type_name(ms)}")
        elif not float(ms).is_integer() or ms <= 0:
            errors.append(f"{path}.ms: expected positive integer")
        return

    if tool_type == "press_key":
        _require_string(value, "key", f"{path}.key", errors)


def _require_target(value, path, errors):
    target = value.get("target")
    if not isinstance(target, dict):
        errors.append(f"{path}.target: expected object, received {_type_name(target)}")
        return

    for key in ("elementId", "selector", "text", "role", "name"):
        target_value = target.get(key)
        if target_value is not None and not isinstance(target_value, str):
            errors.append(f"{path}.target.{key}: expected string or null, received {_type_name(target_value)}")

    coordinates = target.get("coordinates")
    if coordinates is None:
        return
    if not isinstance(coordinates, dict):
        errors.append(f"{path}.target.coordinates: expected object or null, received {_type_name(coordinates)}")
        return
    _require_number(coordinates, "x", f"{path}.target.coordinates.x", errors)
    _require_number(coordinates, "y", f"{path}.target.coordinates.y", errors)


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


def _require_string(value, key, path, errors):
    candidate = value.get(key)
    if not isinstance(candidate, str):
        errors.append(f"{path}: expected string, received {_type_name(candidate)}")


def _require_optional_string(value, key, path, errors):
    if key not in value:
        errors.append(f"{path}: expected string or null, received undefined")
        return
    candidate = value.get(key)
    if candidate is not None and not isinstance(candidate, str):
        errors.append(f"{path}: expected string or null, received {_type_name(candidate)}")


def _require_number(value, key, path, errors):
    candidate = value.get(key)
    if not _is_number(candidate):
        errors.append(f"{path}: expected number, received {_type_name(candidate)}")


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_url(value):
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _type_name(value):
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def selector_for_ref(ref):
    if ref.startswith("#") or ref.startswith(".") or ref.startswith("["):
        return ref
    return f"#{ref}"
