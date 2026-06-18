from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _common.agent import BaseAgent


class PlanActAgent(BaseAgent):
    def step(self, ctx):
        events = []
        if not ctx.steps:
            plan = create_plan(ctx, None)
            events.append({"type": "plan.created", "payload": {"items": plan["items"]}})
        elif ctx.last_step_failed():
            plan = create_plan(ctx, "The previous browser action failed. Replan before continuing.")
            events.append({"type": "plan.updated", "payload": {"items": plan["items"], "reason": "browser_action_failed"}})

        decision = choose_decision(ctx)
        return ctx.with_events(events, decision)


def create_plan(ctx, reason):
    response = ctx.model.complete(build_plan_request(ctx, reason), command_id="plan_1")
    plan = parse_json_object(response.get("text") or "", "plan")
    items = plan.get("items")
    if not isinstance(items, list) or not items:
        raise RuntimeError("Plan response must contain non-empty items")
    return {"items": items}


def choose_decision(ctx):
    last_error = None
    last_raw = ""

    for attempt in range(2):
        response = ctx.model.complete(build_decision_request(ctx, last_error, last_raw), command_id=f"decision_{attempt + 1}")
        last_raw = response.get("text") or ""
        try:
            decision = parse_json_object(last_raw, "decision")
            if decision.get("type") not in ("browser_actions", "final_answer"):
                raise RuntimeError("Decision type must be browser_actions or final_answer")
            return ctx.decision.from_model(decision)
        except RuntimeError as error:
            last_error = str(error)

    raise RuntimeError(f"Invalid model decision after retry. Raw output: {last_raw}")


def build_plan_request(ctx, reason):
    content = [
        f"Task: {ctx.prompt}",
        "",
        "Current observation:",
        ctx.observation_text(),
        "",
        f"Completed steps: {len(ctx.steps)}",
    ]
    if reason:
        content.extend(["", f"Planning reason: {reason}"])

    failed_results = ctx.failed_action_messages()
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


def build_decision_request(ctx, last_error, last_raw):
    content = [
        f"Task: {ctx.prompt}",
        "",
        "Current observation:",
        ctx.observation_text(),
        "",
        f"Completed steps: {len(ctx.steps)}",
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


def parse_json_object(text, label):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Model returned invalid {label} JSON: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Model returned non-object {label} JSON")
    return value


if __name__ == "__main__":
    PlanActAgent().run()
