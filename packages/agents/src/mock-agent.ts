import type { AgentDecision, AgentPlugin, AgentState, RuntimeContext } from "@open-web-agent/core"

export class MockAgent implements AgentPlugin {
  id = "mock-agent"
  name = "Mock Agent"
  description = "Deterministic Sprint 1 agent for Example Domain."

  async initialize(_ctx: RuntimeContext): Promise<void> {}

  async step(state: AgentState, _ctx: RuntimeContext): Promise<AgentDecision> {
    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Open Example Domain, capture a screenshot, and extract text.",
        actions: [
          {
            id: "action_0001",
            kind: "inspect_page_title",
            reason: "The prompt asks for the page title.",
            requiresApproval: false,
            toolCalls: [
              { id: "tool_0001", type: "navigate", url: "https://example.com" },
              { id: "tool_0002", type: "screenshot" },
              { id: "tool_0003", type: "extract_text" },
            ],
          },
        ],
      }
    }

    return {
      type: "final_answer",
      thought: "The mock observation contains the deterministic title.",
      finalAnswer: '페이지 제목은 "Example Domain"입니다.',
      confidence: 1,
    }
  }

  async finalize(state: AgentState, _ctx: RuntimeContext): Promise<string> {
    return state.finalAnswer ?? '페이지 제목은 "Example Domain"입니다.'
  }
}
