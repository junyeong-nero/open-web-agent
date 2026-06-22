from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _common.agent import BaseAgent


MAX_OBSERVATION_ELEMENTS = 60
MAX_OBSERVATION_TEXT_CHARS = 4000
MAX_HISTORY_STEPS = 3


class OccamAgent(BaseAgent):
    def step(self, ctx):
        if ctx.is_blank_page:
            target_url = ctx.target_url_or()
            if target_url:
                return ctx.actions.navigate(
                    "occam_open_target",
                    target_url,
                    reason="Open the target page before applying Occam observation/action alignment.",
                )

        observation = build_occam_observation(ctx.last_observation)
        decision = choose_decision(ctx, observation)
        return ctx.with_events(decision.get("events") or [], decision["decision"])


def choose_decision(ctx, observation):
    last_error = ctx.retry_previous_error
    last_raw = ctx.retry_previous_response_text

    for attempt in range(2):
        response = ctx.model.complete_text(
            system=build_system_prompt(),
            user=build_user_prompt(ctx, observation, last_error, last_raw),
            command_id=f"occam_decision_{attempt + 1}",
        )
        last_raw = response
        try:
            parsed = parse_occam_response(response)
            return translate_occam_command(ctx, observation, parsed)
        except RuntimeError as error:
            last_error = str(error)

    raise RuntimeError(f"Invalid Occam command after retry. Raw output: {last_raw}")


def build_system_prompt():
    return "\n".join(
        [
            "You are an AI assistant performing tasks on a web browser.",
            "You receive a task objective, current step, previous plans, interaction history, and a compact text observation.",
            "Generate the response in exactly these sections:",
            "Interaction history summary: emphasize important details from INTERACTION HISTORY.",
            "Observation description: describe relevant details from CURRENT OBSERVATION.",
            "Reason: explain the next command briefly.",
            "Action: select exactly one command.",
            "Observation Highlight: list the numeric observation ids that support the command, comma-separated.",
            "",
            "You are ONLY allowed to use the following action commands. Strictly adhere to the format.",
            "Planning commands:",
            'branch [parent_plan_id] [new_subplan_intent]: create a new subplan under a previous plan id, e.g. branch [0] [Open the details page]',
            'prune [resume_plan_id] [reason]: return to a previous plan state, e.g. prune [0] [The current path cannot satisfy the task]',
            "",
            "Navigation commands:",
            "click [id]: click an element with its numeric id in CURRENT OBSERVATION.",
            "type [id] [content] [press_enter_after=0|1]: type content into an element. Use [1] to press Enter after typing.",
            "go_back: return to the previous browser page.",
            "note [content]: record important information for later reasoning.",
            "stop [answer]: stop interaction and return the answer.",
            "",
            "Do not use hover, tab operations, raw URLs, selectors, or unlisted browser commands.",
        ]
    )


def build_user_prompt(ctx, observation, last_error, last_raw):
    sections = [
        "OBJECTIVE:",
        ctx.prompt,
        "",
        "CURRENT STEP:",
        str(len(ctx.steps) + 1),
        "",
        "PREVIOUS PLANS:",
        build_previous_plans(ctx),
        "",
        "INTERACTION HISTORY:",
        build_interaction_history(ctx),
        "",
        "CURRENT OBSERVATION:",
        observation["text"],
    ]

    if last_error:
        sections.extend(
            [
                "",
                "PREVIOUS RESPONSE WAS INVALID:",
                last_error,
                "RAW RESPONSE:",
                last_raw,
                "Return a corrected response using the required sections and one valid Action command.",
            ]
        )

    return "\n".join(sections)


def build_previous_plans(ctx):
    prompt = compact_whitespace(ctx.prompt)
    return "\n".join(
        [
            f"0. active - {prompt}",
            "Use branch [0] [subgoal] when a smaller subplan would clarify the next page interaction.",
            "Use prune [0] [reason] when the current path is not useful and you need to resume the root objective.",
        ]
    )


def build_interaction_history(ctx):
    if not ctx.steps:
        return "No previous browser actions."

    lines = []
    recent_steps = ctx.steps[-MAX_HISTORY_STEPS:]
    first_step_number = len(ctx.steps) - len(recent_steps) + 1
    for offset, step in enumerate(recent_steps):
        step_number = first_step_number + offset
        decision = step.get("decision") or {}
        thought = decision.get("thought") if isinstance(decision, dict) else None
        lines.append(f"Step {step_number}: {compact_whitespace(thought or 'No recorded rationale.')}")
        for result in step.get("actionResults") or []:
            status = "ok" if result.get("ok") else "failed"
            message = compact_whitespace(result.get("message") or "")
            if message:
                lines.append(f"- {status}: {message}")
            else:
                lines.append(f"- {status}")
    return "\n".join(lines)


def build_occam_observation(observation):
    if not observation:
        return {"text": "No browser observation has been captured yet.", "elements": []}

    text = compact_whitespace(observation.get("text") or "")
    if len(text) > MAX_OBSERVATION_TEXT_CHARS:
        text = text[:MAX_OBSERVATION_TEXT_CHARS].rstrip() + "..."

    elements = select_observation_elements(observation.get("interactiveElements") or [])
    lines = [
        f"URL: {observation.get('url') or ''}",
        f"Title: {observation.get('title') or ''}",
        "Page text:",
        text or "No extracted page text.",
        "Interactive elements:",
    ]
    if elements:
        lines.extend(format_observation_element(index, element) for index, element in enumerate(elements, start=1))
    else:
        lines.append("None")

    return {"text": "\n".join(lines), "elements": elements}


def select_observation_elements(elements):
    selected = []
    seen = set()
    for element in elements:
        if not isinstance(element, dict):
            continue
        element_id = element.get("id")
        if not element_id:
            continue
        role = compact_whitespace(element.get("role") or "")
        name = compact_whitespace(element.get("name") or "")
        text = compact_whitespace(element.get("text") or "")
        selector = compact_whitespace(element.get("selector") or "")
        key = (role.lower(), name.lower(), text.lower(), selector)
        if key in seen:
            continue
        if not any([role, name, text, selector]):
            continue
        seen.add(key)
        selected.append(element)
        if len(selected) >= MAX_OBSERVATION_ELEMENTS:
            break
    return selected


def format_observation_element(index, element):
    parts = [f"{index}. [{element.get('id')}]"]
    role = compact_whitespace(element.get("role") or "")
    name = compact_whitespace(element.get("name") or "")
    text = compact_whitespace(element.get("text") or "")
    selector = compact_whitespace(element.get("selector") or "")
    if role:
        parts.append(role)
    if name:
        parts.append(f'name="{truncate(name, 120)}"')
    if text:
        parts.append(f'text="{truncate(text, 160)}"')
    if selector and not (name or text):
        parts.append(f'selector="{truncate(selector, 120)}"')
    return " ".join(parts)


def parse_occam_response(text):
    action = extract_section(text, "Action")
    reason = extract_section(text, "Reason") or None
    if not action:
        action = extract_first_command(text)
    if not action:
        raise RuntimeError("Occam response did not contain an Action command")
    return {"action": normalize_action_text(action), "reason": compact_whitespace(reason or "") or None}


def extract_section(text, section_name):
    pattern = re.compile(
        rf"{re.escape(section_name)}\s*:\s*(.*?)(?=\n\s*(?:Interaction history summary|Observation description|Reason|Action|Observation Highlight)\s*:|\Z)",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(text or "")
    if not match:
        return ""
    return match.group(1).strip()


def extract_first_command(text):
    fence_match = re.search(r"```(?:text)?\s*(.*?)```", text or "", re.IGNORECASE | re.DOTALL)
    if fence_match:
        fenced = normalize_action_text(fence_match.group(1))
        if command_name(fenced):
            return fenced

    command_match = re.search(
        r"\b(?:branch|prune|click|type|note|stop)\s*\[.*?\](?:\s*\[.*?\])?|\bgo_back\b",
        text or "",
        re.IGNORECASE | re.DOTALL,
    )
    return command_match.group(0).strip() if command_match else ""


def normalize_action_text(action):
    action = (action or "").strip().strip("`").strip()
    action = re.sub(r"^Action\s*:\s*", "", action, flags=re.IGNORECASE).strip()
    if "\n" in action:
        for line in action.splitlines():
            candidate = line.strip().strip("`").strip()
            if command_name(candidate):
                return candidate
    return action


def translate_occam_command(ctx, observation, parsed):
    action = parsed["action"]
    reason = parsed["reason"]
    command = command_name(action)

    if command == "click":
        element = element_for_action(action, observation)
        decision = browser_decision(
            "occam_click",
            "click",
            reason,
            [{"id": "occam_click_tool", "type": "click", "target": {"elementId": element["id"]}}],
        )
        return {"decision": ctx.decision.from_model(decision, ctx.last_observation)}

    if command == "type":
        element, value, press_enter = parse_type_action(action, observation)
        tool_calls = [
            {"id": "occam_type_tool", "type": "type", "target": {"elementId": element["id"]}, "value": value},
        ]
        if press_enter:
            tool_calls.append({"id": "occam_type_enter_tool", "type": "press_key", "key": "Enter"})
        decision = browser_decision("occam_type", "type", reason, tool_calls)
        return {"decision": ctx.decision.from_model(decision, ctx.last_observation)}

    if command == "go_back":
        decision = browser_decision("occam_go_back", "go_back", reason, [{"id": "occam_go_back_tool", "type": "go_back"}])
        return {"decision": ctx.decision.from_model(decision, ctx.last_observation)}

    if command == "stop":
        answer = parse_single_bracket_payload(action, "stop")
        return {"decision": ctx.final_answer(answer, thought=reason, confidence=1)}

    if command == "note":
        note = parse_single_bracket_payload(action, "note")
        events = [plan_event("plan.updated", note_plan_items(ctx, note), "occam_note")]
        return {"events": events, "decision": wait_decision("occam_note", reason)}

    if command == "branch":
        parent_id, intent = parse_planning_action(action, "branch")
        events = [plan_event("plan.updated", branch_plan_items(ctx, parent_id, intent), "occam_branch")]
        return {"events": events, "decision": wait_decision("occam_branch", reason)}

    if command == "prune":
        resume_id, prune_reason = parse_planning_action(action, "prune")
        events = [plan_event("plan.updated", prune_plan_items(ctx, resume_id, prune_reason), "occam_prune")]
        return {"events": events, "decision": wait_decision("occam_prune", reason)}

    raise RuntimeError(f"Unsupported Occam action command: {action}")


def command_name(action):
    match = re.match(r"\s*([a-z_]+)\b", action or "", re.IGNORECASE)
    if not match:
        return ""
    command = match.group(1).lower()
    return command if command in {"branch", "prune", "click", "type", "go_back", "note", "stop"} else ""


def element_for_action(action, observation):
    match = re.search(r"\[(\d+)\]", action)
    if not match:
        raise RuntimeError(f"Occam action requires a numeric observation id: {action}")
    index = int(match.group(1))
    elements = observation["elements"]
    if index < 1 or index > len(elements):
        raise RuntimeError(f"Occam action referenced unknown observation id {index}")
    return elements[index - 1]


def parse_type_action(action, observation):
    match = re.search(r"type\s*\[(\d+)\]\s*\[(.*?)\]\s*(?:\[(0|1)\])?\s*$", action, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError(f"Invalid Occam type command: {action}")
    element = element_for_action(f"click [{match.group(1)}]", observation)
    value = match.group(2)
    press_enter = (match.group(3) or "1") == "1"
    return element, value, press_enter


def parse_single_bracket_payload(action, command):
    match = re.search(rf"{command}\s*\[(.*)\]\s*$", action, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError(f"Invalid Occam {command} command: {action}")
    return match.group(1).strip()


def parse_planning_action(action, command):
    match = re.search(rf"{command}\s*\[(\d+)\]\s*\[(.*)\]\s*$", action, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError(f"Invalid Occam {command} command: {action}")
    return match.group(1), compact_whitespace(match.group(2))


def browser_decision(action_id, kind, reason, tool_calls):
    return {
        "type": "browser_actions",
        "thought": reason,
        "actions": [
            {
                "id": action_id,
                "kind": kind,
                "reason": reason,
                "requiresApproval": False,
                "toolCalls": tool_calls,
            }
        ],
    }


def wait_decision(action_id, reason):
    return browser_decision(
        action_id,
        "plan",
        reason,
        [{"id": f"{action_id}_wait_tool", "type": "wait", "ms": 1}],
    )


def plan_event(event_type, items, reason):
    return {"type": event_type, "payload": {"items": items, "reason": reason}}


def branch_plan_items(ctx, parent_id, intent):
    branch_id = str(len(ctx.steps) + 1)
    return [
        {"id": parent_id, "title": compact_whitespace(ctx.prompt), "status": "completed"},
        {"id": branch_id, "title": intent, "status": "active"},
    ]


def prune_plan_items(ctx, resume_id, reason):
    return [
        {"id": resume_id, "title": compact_whitespace(ctx.prompt), "status": "active"},
        {"id": f"{resume_id}-pruned", "title": reason, "status": "completed"},
    ]


def note_plan_items(ctx, note):
    note_id = f"note-{len(ctx.steps) + 1}"
    return [
        {"id": "0", "title": compact_whitespace(ctx.prompt), "status": "active"},
        {"id": note_id, "title": note, "status": "completed"},
    ]


def compact_whitespace(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def truncate(value, limit):
    value = compact_whitespace(value)
    if len(value) <= limit:
        return value
    return value[: limit - 3].rstrip() + "..."


if __name__ == "__main__":
    OccamAgent().run()
