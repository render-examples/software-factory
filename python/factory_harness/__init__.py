"""Runs a Pydantic AI agent behind the software-factory runner contract (app/runner/core/protocol.ts).

An agent module builds its agent with Pydantic AI and hands it over:

    from pydantic_ai import Agent
    from factory_harness import serve

    serve(Agent("anthropic:claude-sonnet-5"))

The runner launches `python -m factory_harness --module <path>` in the sandbox. The model, provider settings, and
library options come from the agent. The factory supplies the prompt, the tools (over MCP, from the runner), the
`submit` tool built from the output schema, and the turn and time limits.
"""

from __future__ import annotations

from typing import Any

_registered: list[Any] = []


def serve(agent: Any) -> None:
    """Registers the module's agent with the harness. Call it once, at import."""
    _registered.append(agent)
