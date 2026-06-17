import { SimpleReActAgent, type SimpleReActAgentOptions } from "./simple-react-agent"

export class SeeActAgent extends SimpleReActAgent {
  id = "see-act"
  name = "See-Act Agent"
  description = "Uses the selected model to observe the browser and choose actions."

  constructor(options: SimpleReActAgentOptions) {
    super(options)
  }
}
