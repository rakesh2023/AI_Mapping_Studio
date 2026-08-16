# 13 — Agentic AI

**This application does not implement agentic AI.** There are **no autonomous agents, no orchestrator, no tool/function‑calling loop, and no multi‑step agent state or memory.**

Verified in the code:
- Every LLM interaction is a **single, bounded request → response** through `ai_client_service.call_ai` (see [10](10-ai-genai-architecture.md)). The model returns JSON or SQL that the service parses; the model never decides to call a tool, and there is no loop where the model's output drives further tool selection.
- There is **no Anthropic tool‑use / function‑calling** (`tools=[...]`) anywhere. Structured output uses `output_config`/`json_schema` (a formatting constraint), not tools.
- The only iterative behaviors are **deterministic, code‑controlled loops**, not agentic:
  - Mapping generation loops per target entity / field‑chunk (`mapping_service`).
  - Extraction loops per file chunk (`extraction_service`).
  - ETL/DDL auto‑continuation on `max_tokens` (`etl_service`).
  - Deploy retries a failed batch once with an AI fix, then **stops for human review** (`deployment_service` + `ai_fix_service`) — the control flow is Python, not the model.

There is therefore no agent to document (no agent name, model, tools, decision process, handoffs, or termination condition to enumerate).

### Recommended Improvement (optional)

The deploy fix‑and‑retry flow is the closest candidate to an agent. If desired, it could be reframed as a small tool‑using agent (tools: *run batch*, *fix batch*), but today it is a fixed two‑step, human‑gated procedure by design (the AI fix is never auto‑deployed).
