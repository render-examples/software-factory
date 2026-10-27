"""Claude Sonnet 5 on Pydantic AI. The factory supplies the prompt, tools, output, and limits for each run."""

from pydantic_ai import Agent

from factory_harness import serve

serve(Agent("anthropic:claude-sonnet-5"))
