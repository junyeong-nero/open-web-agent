from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _common.agent import BaseAgent


class TextVisionMixedGroundingAgent(BaseAgent):
    def step(self, ctx):
        observation = ctx.last_observation or {}
        text = observation.get("text")
        screenshot_path = observation.get("screenshotPath")

        if not text or not screenshot_path:
            return build_observation_decision(ctx, observation, bool(text), bool(screenshot_path))

        answer = ctx.model.complete_text(
            system=(
                "You are Open Web Agent's mixed grounding agent. "
                "Answer the user's task using both extracted page text and the screenshot image. "
                "Be concise and do not mention file paths."
            ),
            user=[
                {
                    "type": "text",
                    "text": "\n".join(
                        [
                            f"Task: {ctx.prompt}",
                            f"URL: {observation.get('url') or ''}",
                            f"Title: {observation.get('title') or ''}",
                            "",
                            "Extracted text:",
                            text or "",
                        ]
                    ),
                },
                {"type": "image_url", "image_url": {"url": ctx.screenshot_data_url()}},
            ],
            command_id="grounding_1",
        )
        ctx.events.plan_updated(
            [
                {"id": "open-page", "title": "Open the target page", "status": "completed"},
                {"id": "ground-text", "title": "Use extracted text", "status": "completed"},
                {"id": "ground-vision", "title": "Use screenshot image", "status": "completed"},
            ],
            reason="mixed_grounding_model_complete",
        )
        return ctx.final_answer(
            answer or "The selected model returned an empty grounding answer.",
            thought="The answer comes from the selected model using extracted text and screenshot content.",
        )


def build_observation_decision(ctx, observation, has_text, has_screenshot):
    current_url = observation.get("url") or "about:blank"
    target_url = ctx.target_url_or()
    tool_calls = []

    if current_url == "about:blank":
        if not target_url:
            return {
                "decision": ctx.final_answer(
                    "Please include a URL or domain so I can capture text and screenshot grounding.",
                    thought="A page URL is required before text and vision grounding can run.",
                    confidence=0.2,
                )
            }
        tool_calls.append(ctx.tool_calls.navigate("navigate_target", target_url))

    if not has_screenshot:
        tool_calls.append(ctx.tool_calls.screenshot("capture_screenshot"))
    if not has_text:
        tool_calls.append(ctx.tool_calls.extract_text("extract_text"))

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
        "decision": ctx.browser_action(
            "mixed_grounding_observe",
            tool_calls,
            kind="mixed_grounding_observe",
            reason="Collect browser text and screenshot content for model grounding.",
            thought="Need extracted text and a screenshot artifact before the model can ground the answer.",
        ),
    }


if __name__ == "__main__":
    TextVisionMixedGroundingAgent().run()
