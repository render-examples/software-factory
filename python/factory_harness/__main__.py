"""`python -m factory_harness --module <path>`: one agent run. `--self-test` checks the environment instead.

stdin carries one JSON object from the runner's pydantic adapter (app/harness/pydantic.ts):
  input        the validated RunnerInput
  api_key      the model key, or null under --test-stub
  key_env      the env var the agent's provider reads its key from
  test_script  scripted model turns, or null for a real model
  mcp          {command, args}: the runner's factory-tool MCP server for this agent's tools
stdout carries RunnerEvent JSONL and nothing else; everything else goes to stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import runpy
import sys
from datetime import UTC, datetime
from typing import Any

EXIT = {"ok": 0, "error": 1, "invalid_input": 2, "timeout": 3}
SUBMIT_TOOL = "submit"
MAX_SUBMIT_ATTEMPTS = 3
SUBMIT_ACCEPTED = "Submission recorded. You are done."
PREVIEW_CHARS = 2000
TRUNCATED = "…[truncated]"
# Seconds kept back from timeout_ms so the harness reports its own timeout before the runner stops it.
SAFETY_MARGIN_S = 10


def make_non_dumpable() -> None:
    """Keeps same-uid tool subprocesses from reading this process's memory (the model key) through /proc."""
    if sys.platform.startswith("linux"):
        PR_SET_DUMPABLE = 4
        if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) failed")


class Emitter:
    """Writes one RunnerEvent per line to the contract's stdout. Drops everything after the first terminal event."""

    def __init__(self, stream: Any, secrets: list[str]) -> None:
        self.stream = stream
        self.secrets = [s for s in secrets if s]
        self.terminated = False

    def __call__(self, event: dict[str, Any]) -> None:
        if self.terminated:
            return
        self.terminated = event["type"] in ("result", "error")
        at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        line = json.dumps({"type": event["type"], "at": at, **{k: v for k, v in event.items() if k != "type"}}, default=str)
        for secret in self.secrets:
            line = line.replace(secret, "[REDACTED]")
        self.stream.write(line + "\n")
        self.stream.flush()


def preview(text: str) -> str:
    return text if len(text) <= PREVIEW_CHARS else text[: PREVIEW_CHARS - len(TRUNCATED)] + TRUNCATED


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c if isinstance(c, str) else getattr(c, "text", json.dumps(c, default=str)) for c in content)
    return json.dumps(content, default=str)


class SubmissionExhausted(Exception):
    """The last allowed submit attempt was rejected."""


class Submission:
    """Checks each submit attempt against the output JSON Schema and counts rejections (core/submit.ts in Python)."""

    def __init__(self, schema: dict[str, Any]) -> None:
        from jsonschema import Draft202012Validator

        self.validator = Draft202012Validator(schema)
        self.rejected = 0
        self.accepted: dict[str, Any] | None = None

    def check(self, args: Any) -> str | None:
        """None when `args` is accepted; otherwise the message for the model. Raises after the last attempt."""
        errors = sorted(self.validator.iter_errors(args), key=lambda e: list(e.absolute_path))
        if not errors:
            self.accepted = {"output": args}
            return None
        problems = list(dict.fromkeys(f"{_path(e)}: {_describe(e)}" for e in errors))
        self.rejected += 1
        remaining = MAX_SUBMIT_ATTEMPTS - self.rejected
        message = (
            f"{SUBMIT_TOOL} rejected (attempt {self.rejected} of {MAX_SUBMIT_ATTEMPTS}); nothing was recorded. "
            + ("Fix every problem below and call it again:\n" if remaining > 0 else "No attempts remain:\n")
            + "\n".join(f"- {p}" for p in problems)
        )
        if remaining > 0:
            return message
        # Schema paths and field names only, as in core/submit.ts: never the submitted values.
        fields = list(args.keys()) if isinstance(args, dict) else []
        names = ", ".join(f[:40] for f in fields[:20]) or "none"
        last = "; ".join(p.split(": ", 1)[0] + ": " + _rule(e) for p, e in zip(problems[:5], errors[:5]))
        raise SubmissionExhausted(f"{SUBMIT_TOOL} was rejected {self.rejected} times; last: {last}; submitted fields: {names}")


def _path(error: Any) -> str:
    return "/" + "/".join(map(str, error.absolute_path)) if error.absolute_path else "(root)"


def _describe(error: Any) -> str:
    """jsonschema's message, worded like core/submit.ts where they differ."""
    if error.validator == "additionalProperties" and isinstance(error.instance, dict):
        allowed = set(error.schema.get("properties", {}))
        extra = ", ".join(sorted(k for k in error.instance if k not in allowed))
        return f"must not have additional properties ({extra})"
    return error.message


def _rule(error: Any) -> str:
    """A validation failure described by its rule, without quoting the submitted value."""
    return f"must satisfy {error.validator}"


def submit_description(schema: dict[str, Any]) -> str:
    what = f" {schema['description']}" if isinstance(schema.get("description"), str) and schema["description"] else ""
    return (
        f"Submit your final output.{what} Call it exactly once, as your final action, on its own. The arguments are "
        "checked against the schema; a rejected submission records nothing, so fix every listed problem and call it "
        f"again ({MAX_SUBMIT_ATTEMPTS} attempts in total)."
    )


def model_label(model: Any) -> str:
    if isinstance(model, str):
        return model
    system = getattr(model, "system", None)
    name = getattr(model, "model_name", None)
    return f"{system}:{name}" if system and name else type(model).__name__


def scripted_model(turns: list[dict[str, Any]]) -> Any:
    """A FunctionModel that plays the runner's test script, one turn per model request."""
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from pydantic_ai.models.function import FunctionModel

    queue = list(turns)
    counter = {"n": 0}

    def respond(_messages: Any, _info: Any) -> Any:
        if not queue:
            return ModelResponse(parts=[TextPart("[test-stub] The script has no more turns.")])
        turn = queue.pop(0)
        parts: list[Any] = [TextPart(turn["text"])] if turn.get("text") else []
        for call in turn["calls"]:
            counter["n"] += 1
            parts.append(ToolCallPart(call["name"], call["args"], tool_call_id=f"call-{counter['n']}"))
        return ModelResponse(parts=parts)

    return FunctionModel(respond, model_name="test-stub")


async def run(agent: Any, handoff: dict[str, Any], emit: Emitter) -> int:
    import pydantic_ai
    from pydantic_ai import Agent, ModelRetry, StructuredDict, ToolOutput
    from pydantic_ai.exceptions import RunTimedOut, UnexpectedModelBehavior, UsageLimitExceeded
    from pydantic_ai.mcp import MCPToolset, StdioTransport
    from pydantic_ai.messages import RetryPromptPart, TextPart, ToolCallPart, ToolReturnPart
    from pydantic_ai.usage import UsageLimits

    input_ = handoff["input"]
    schema = {k: v for k, v in input_["output_schema"].items() if k not in ("$schema", "$id")}
    test_script = handoff.get("test_script")
    model = scripted_model(test_script) if test_script is not None else agent.model
    emit(
        {
            "type": "started",
            "agent_id": input_["agent_id"],
            "harness": "pydantic",
            "harness_version": pydantic_ai.__version__,
            "model": "test-stub" if test_script is not None else model_label(model),
        }
    )

    submission = Submission(schema)
    Output = StructuredDict(schema, name="submit_output")

    def submit(value: Any) -> dict[str, Any]:
        problem = submission.check(value)
        if problem:
            raise ModelRetry(problem)
        return value

    # Set at runtime: the schema exists only now, and string annotations (from __future__) can't name a local type.
    submit.__annotations__ = {"value": Output, "return": dict[str, Any]}

    toolsets = []
    if input_["tools"]:
        mcp = handoff["mcp"]
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "HOME", "TMPDIR")}
        # A tool failure is information for the model, not a reason to end the run; max_turns bounds the run.
        toolsets.append(MCPToolset(StdioTransport(mcp["command"], mcp["args"], env=env, cwd=input_["cwd"]), max_retries=input_["max_turns"]))

    turns = 0
    pending: dict[str, str] = {}

    def forward_request(request: Any) -> None:
        for part in request.parts:
            if isinstance(part, (ToolReturnPart, RetryPromptPart)) and part.tool_name:
                # A failed call comes back as a retry prompt, or as a return part whose outcome isn't success.
                is_error = isinstance(part, RetryPromptPart) or getattr(part, "outcome", "success") != "success"
                text = part.content if isinstance(part.content, str) else content_text(part.content)
                pending.pop(part.tool_call_id, None)
                emit({"type": "tool_result", "tool_call_id": part.tool_call_id, "tool": part.tool_name, "is_error": is_error, "output_preview": preview(text)})

    def forward_response(response: Any) -> None:
        text = "\n".join(p.content for p in response.parts if isinstance(p, TextPart)).strip()
        if text:
            emit({"type": "assistant_text", "text": text})
        usage = response.usage
        tokens = {
            "input_tokens": usage.input_tokens or 0,
            "output_tokens": usage.output_tokens or 0,
            "cache_read_tokens": usage.cache_read_tokens or 0,
            "cache_write_tokens": usage.cache_write_tokens or 0,
        }
        if any(tokens.values()):
            emit({"type": "usage", "usage": {**tokens, **_cost(response)}})
        for part in response.parts:
            if isinstance(part, ToolCallPart):
                pending[part.tool_call_id] = part.tool_name
                emit({"type": "tool_call", "tool_call_id": part.tool_call_id, "tool": part.tool_name, "args": part.args_as_dict()})

    def fail(code: str, message: str) -> int:
        emit({"type": "error", "code": code, "message": message})
        return EXIT["timeout"] if code == "timeout" else EXIT["error"]

    budget = max(1.0, input_["timeout_ms"] / 1000 - min(SAFETY_MARGIN_S, input_["timeout_ms"] / 10000))
    try:
        async with agent.iter(
            input_["message"],
            output_type=ToolOutput(submit, name=SUBMIT_TOOL, description=submit_description(schema), max_retries=MAX_SUBMIT_ATTEMPTS + 1),
            model=model,
            instructions=input_["system_prompt"],
            usage_limits=UsageLimits(request_limit=input_["max_turns"]),
            retries={"tools": input_["max_turns"], "output": MAX_SUBMIT_ATTEMPTS + 1},
            toolsets=toolsets,
            timeout=budget,
        ) as agent_run:
            async for node in agent_run:
                if Agent.is_model_request_node(node):
                    forward_request(node.request)
                elif Agent.is_call_tools_node(node):
                    turns += 1
                    forward_response(node.model_response)
    except BaseException as err:  # noqa: BLE001 - every failure becomes one contract error
        cause = _unwrap(err)
        if isinstance(cause, SubmissionExhausted):
            return fail("invalid_submission", str(cause))
        if isinstance(cause, UsageLimitExceeded):
            return fail("max_turns", f"turn limit ({input_['max_turns']}) reached without a submission")
        if isinstance(cause, (RunTimedOut, asyncio.TimeoutError)):
            return fail("timeout", f"the run exceeded its {int(budget * 1000)} ms budget")
        if isinstance(cause, UnexpectedModelBehavior) and submission.accepted is None:
            return fail("no_submission", f"the model stopped without calling {SUBMIT_TOOL}: {cause}")
        if isinstance(cause, (KeyboardInterrupt, SystemExit)):
            return fail("agent_error", "the run was cancelled")
        return fail("agent_error", f"{type(cause).__name__}: {cause}")

    if submission.accepted is None:
        return fail("no_submission", f"the model stopped without calling {SUBMIT_TOOL}")
    for call_id, tool in pending.items():
        if tool == SUBMIT_TOOL:
            emit({"type": "tool_result", "tool_call_id": call_id, "tool": tool, "is_error": False, "output_preview": SUBMIT_ACCEPTED})
    emit({"type": "result", "output": submission.accepted["output"], "turns": turns})
    return EXIT["ok"]


def _cost(response: Any) -> dict[str, float]:
    """The response's price from Pydantic AI's price data, or nothing when the model has no known price."""
    try:
        price = float(response.cost().total_price)
    except Exception:  # noqa: BLE001 - unpriced models (and the test stub) report tokens only
        return {}
    return {"cost_usd": price} if price >= 0 else {}


def _unwrap(err: BaseException) -> BaseException:
    """The first meaningful exception inside an ExceptionGroup (MCP and anyio task groups wrap failures)."""
    while isinstance(err, BaseExceptionGroup) and err.exceptions:
        err = next((e for e in err.exceptions if not isinstance(e, asyncio.CancelledError)), err.exceptions[0])
    return err


def self_test() -> int:
    import jsonschema  # noqa: F401
    import pydantic_ai

    from pydantic_ai.mcp import MCPToolset  # noqa: F401

    sys.__stdout__.write(json.dumps({"ok": True, "pydantic_ai": pydantic_ai.__version__, "python": sys.version.split()[0]}) + "\n")
    return EXIT["ok"]


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m factory_harness")
    parser.add_argument("--module", help="the agent module, relative to the python/ directory")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    make_non_dumpable()
    contract = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    # stdout carries only RunnerEvent JSONL; route library output (banners, prints) to stderr.
    sys.stdout = sys.stderr
    handoff = json.loads(sys.stdin.read())
    api_key = handoff.get("api_key") or ""
    emit = Emitter(contract, [api_key])

    if not args.module:
        emit({"type": "error", "code": "invalid_input", "message": "--module is required"})
        return EXIT["invalid_input"]
    if handoff.get("test_script") is None:
        if not api_key:
            emit({"type": "error", "code": "agent_error", "message": f"no API key for {handoff.get('key_env')}"})
            return EXIT["error"]
        # The provider reads its key from this process's environment; the MCP tool server gets an explicit env without it.
        os.environ[handoff["key_env"]] = api_key
    else:
        # Providers refuse to build without a key; the scripted model replaces the agent's model, so it is never used.
        os.environ[handoff["key_env"]] = "test-stub-placeholder"

    import factory_harness

    try:
        runpy.run_path(args.module, run_name="factory_agent")
    except Exception as err:  # noqa: BLE001
        emit({"type": "error", "code": "invalid_input", "message": f"could not load {args.module}: {type(err).__name__}: {err}"})
        return EXIT["invalid_input"]
    if len(factory_harness._registered) != 1:
        emit({"type": "error", "code": "invalid_input", "message": f"{args.module} must call serve(agent) exactly once"})
        return EXIT["invalid_input"]
    return asyncio.run(run(factory_harness._registered[0], handoff, emit))


if __name__ == "__main__":
    sys.exit(main())
