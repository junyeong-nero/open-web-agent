import json
import itertools
import re
from pathlib import Path

from .protocol import (
    call_model,
    emit_response,
    format_browser_tools,
    format_observation,
    normalize_decision,
    parse_json_object,
    read_request,
    repair_decision_targets,
    validate_agent_decision,
)


URL_RE = re.compile(r"https?://[^\s)>,]+", re.IGNORECASE)
DOMAIN_RE = re.compile(r"\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:/[^\s)>,]+)?")


class BaseAgent:
    def run(self):
        request = read_request()
        ctx = AgentContext(request)
        method = request.get("method")

        if method == "initialize":
            emit_response(self.initialize(ctx))
            return
        if method == "step":
            emit_response(ctx.prepare_step_response(self.step(ctx)))
            return
        if method == "finalize":
            emit_response(ctx.prepare_finalize_response(self.finalize(ctx)))
            return

        raise SystemExit(f"Unsupported method: {method}")

    def initialize(self, ctx):
        return {"ok": True}

    def step(self, ctx):
        raise NotImplementedError("BaseAgent subclasses must implement step(ctx)")

    def finalize(self, ctx):
        return ctx.final_answer_text or ""


class AgentContext:
    def __init__(self, request):
        self.request = request
        self.agent = request.get("agent") or {}
        self.state = request.get("state") or {}
        self.context = request.get("context") or {}
        self.retry = request.get("retry") if isinstance(request.get("retry"), dict) else None
        self.events = EventRecorder()
        self.model = ModelClient()
        self.tool_calls = ToolCallFactory()
        self.actions = ActionFactory(self.tool_calls)
        self.decision = DecisionFactory()

    @property
    def prompt(self):
        return self.state.get("prompt") or ""

    @property
    def steps(self):
        return self.state.get("steps") or []

    @property
    def last_observation(self):
        return self.state.get("lastObservation") or None

    @property
    def final_answer_text(self):
        return self.state.get("finalAnswer")

    @property
    def retry_attempt(self):
        if not self.retry:
            return 0
        return self.retry.get("attempt") or 0

    @property
    def retry_previous_error(self):
        if not self.retry:
            return None
        return self.retry.get("previousError")

    @property
    def retry_previous_response(self):
        if not self.retry:
            return None
        return self.retry.get("previousResponse")

    @property
    def retry_previous_response_text(self):
        value = self.retry_previous_response
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @property
    def run_dir(self):
        return self.context.get("runDir")

    @property
    def agent_id(self):
        return self.context.get("agentId")

    @property
    def model_id(self):
        return self.context.get("modelId")

    @property
    def environment_id(self):
        return self.context.get("environmentId")

    @property
    def browser_tools(self):
        value = self.context.get("browserTools")
        return value if isinstance(value, list) else []

    def browser_tools_text(self):
        return format_browser_tools(self.browser_tools)

    @property
    def is_blank_page(self):
        observation = self.last_observation or {}
        return (observation.get("url") or "about:blank") == "about:blank"

    def last_step_failed(self):
        if not self.steps:
            return False
        return any(not result.get("ok") for result in self.steps[-1].get("actionResults") or [])

    def failed_action_messages(self):
        messages = []
        for step in self.steps:
            for result in step.get("actionResults") or []:
                if not result.get("ok"):
                    messages.append(result.get("message") or "Browser action failed")
        return messages

    def observation_text(self, limit_elements=20):
        return format_observation_with_limit(self.last_observation, limit_elements)

    def target_url_or(self, default=None):
        return extract_target_url(self.prompt) or default

    def screenshot_data_url(self):
        observation = self.last_observation or {}
        path = observation.get("screenshotPath")
        if not path:
            raise RuntimeError("No screenshotPath is available in the last observation")
        return screenshot_data_url(path)

    def final_answer(self, text, thought=None, confidence=1):
        return {
            "type": "final_answer",
            "thought": thought,
            "finalAnswer": text,
            "confidence": confidence,
        }

    def browser_action(self, action_id, tool_calls, kind=None, reason=None, requires_approval=False, thought=None):
        return {
            "type": "browser_actions",
            "thought": thought if thought is not None else reason,
            "actions": [
                {
                    "id": action_id,
                    "kind": kind or action_id,
                    "reason": reason,
                    "requiresApproval": requires_approval,
                    "toolCalls": tool_calls,
                }
            ],
        }

    def with_events(self, events, decision):
        return {"events": events, "decision": decision}

    def prepare_step_response(self, result):
        if isinstance(result, dict) and "decision" in result:
            events = [*self.events.drain(), *(result.get("events") or [])]
            response = dict(result)
            if events:
                response["events"] = events
            return response

        response = {"decision": result}
        events = self.events.drain()
        if events:
            response["events"] = events
        return response

    def prepare_finalize_response(self, result):
        if isinstance(result, dict) and "finalAnswer" in result:
            events = [*self.events.drain(), *(result.get("events") or [])]
            response = dict(result)
            if events:
                response["events"] = events
            return response

        response = {"finalAnswer": result or ""}
        events = self.events.drain()
        if events:
            response["events"] = events
        return response


class EventRecorder:
    def __init__(self):
        self._events = []

    def emit(self, event_type, payload, step_id=None):
        event = {"type": event_type, "payload": payload}
        if step_id is not None:
            event["stepId"] = step_id
        self._events.append(event)
        return event

    def plan_created(self, items):
        return self.emit("plan.created", {"items": items})

    def plan_updated(self, items, reason=None):
        payload = {"items": items}
        if reason is not None:
            payload["reason"] = reason
        return self.emit("plan.updated", payload)

    def drain(self):
        events = self._events
        self._events = []
        return events


class ModelClient:
    _ids = itertools.count(1)

    def complete(self, request, command_id=None):
        return call_model(request, command_id or f"model_{next(self._ids)}")

    def complete_text(self, system, user, temperature=None, command_id=None, **kwargs):
        response = self.complete(self._request(system, user, "text", temperature, **kwargs), command_id=command_id)
        return response.get("text") or ""

    def complete_json(self, system, user, temperature=None, command_id=None, **kwargs):
        response = self.complete(self._request(system, user, "json", temperature, **kwargs), command_id=command_id)
        return parse_json_object(response.get("text") or "", "model response")

    def _request(self, system, user, response_format, temperature, **kwargs):
        request = {
            "model": kwargs.pop("model", ""),
            "responseFormat": response_format,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if temperature is not None:
            request["temperature"] = temperature
        request.update(kwargs)
        return request


class ToolCallFactory:
    def navigate(self, tool_id, url):
        return {"id": tool_id, "type": "navigate", "url": url}

    def click(self, tool_id, selector=None, element_id=None, text=None, role=None, name=None, coordinates=None):
        return {"id": tool_id, "type": "click", "target": target(selector, element_id, text, role, name, coordinates)}

    def type(self, tool_id, value, selector=None, element_id=None, text=None, role=None, name=None, coordinates=None):
        return {
            "id": tool_id,
            "type": "type",
            "target": target(selector, element_id, text, role, name, coordinates),
            "value": value,
        }

    def scroll(self, tool_id, delta_y, delta_x=0):
        return {"id": tool_id, "type": "scroll", "deltaX": delta_x, "deltaY": delta_y}

    def wait(self, tool_id, ms):
        return {"id": tool_id, "type": "wait", "ms": ms}

    def press_key(self, tool_id, key):
        return {"id": tool_id, "type": "press_key", "key": key}

    def screenshot(self, tool_id):
        return {"id": tool_id, "type": "screenshot"}

    def extract_text(self, tool_id):
        return {"id": tool_id, "type": "extract_text"}

    def go_back(self, tool_id):
        return {"id": tool_id, "type": "go_back"}

    def go_forward(self, tool_id):
        return {"id": tool_id, "type": "go_forward"}


class ActionFactory:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls

    def navigate(self, action_id, url, reason=None):
        return single_tool_decision(action_id, "navigate", reason, self.tool_calls.navigate(f"{action_id}_tool", url))

    def click(self, action_id, selector=None, element_id=None, text=None, role=None, name=None, reason=None, coordinates=None):
        return single_tool_decision(
            action_id,
            "click",
            reason,
            self.tool_calls.click(f"{action_id}_tool", selector, element_id, text, role, name, coordinates),
        )

    def type(self, action_id, value, selector=None, element_id=None, text=None, role=None, name=None, reason=None, coordinates=None):
        return single_tool_decision(
            action_id,
            "type",
            reason,
            self.tool_calls.type(f"{action_id}_tool", value, selector, element_id, text, role, name, coordinates),
        )

    def screenshot(self, action_id="capture_screenshot", reason=None):
        return single_tool_decision(action_id, "screenshot", reason, self.tool_calls.screenshot(f"{action_id}_tool"))

    def extract_text(self, action_id="extract_text", reason=None):
        return single_tool_decision(action_id, "extract_text", reason, self.tool_calls.extract_text(f"{action_id}_tool"))

    def wait(self, action_id, ms, reason=None):
        return single_tool_decision(action_id, "wait", reason, self.tool_calls.wait(f"{action_id}_tool", ms))

    def press_key(self, action_id, key, reason=None):
        return single_tool_decision(action_id, "press_key", reason, self.tool_calls.press_key(f"{action_id}_tool", key))


class DecisionFactory:
    def from_model(self, value, observation=None):
        decision = normalize_decision(value)
        if observation:
            decision = repair_decision_targets(decision, observation)
        return validate_agent_decision(decision)


def single_tool_decision(action_id, kind, reason, tool_call):
    return {
        "type": "browser_actions",
        "thought": reason,
        "actions": [
            {
                "id": action_id,
                "kind": kind,
                "reason": reason,
                "requiresApproval": False,
                "toolCalls": [tool_call],
            }
        ],
    }


def target(selector=None, element_id=None, text=None, role=None, name=None, coordinates=None):
    return {
        "elementId": element_id,
        "selector": selector,
        "text": text,
        "role": role,
        "name": name,
        "coordinates": coordinates,
    }


def format_observation_with_limit(observation, limit_elements=20):
    if limit_elements == 20:
        return format_observation(observation)
    if not observation:
        return "No browser observation has been captured yet."

    limited = dict(observation)
    limited["interactiveElements"] = (observation.get("interactiveElements") or [])[:limit_elements]
    return format_observation(limited)


def screenshot_data_url(path):
    import base64
    import mimetypes

    screenshot_path = Path(path)
    media_type = mimetypes.guess_type(screenshot_path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(screenshot_path.read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def extract_target_url(prompt):
    match = URL_RE.search(prompt or "")
    if match:
        return strip_trailing_punctuation(match.group(0))

    match = DOMAIN_RE.search(prompt or "")
    if not match:
        return None
    return "https://" + strip_trailing_punctuation(match.group(0))


def strip_trailing_punctuation(value):
    return value.rstrip(".,;:")
