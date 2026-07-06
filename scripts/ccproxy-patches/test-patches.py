#!/usr/bin/env python3
"""test-patches.py — Regression tests for the ccproxy-api patches.

These tests verify that the RequestContentBlock schema in ccproxy-api includes
the ThinkingBlock and RedactedThinkingBlock content types — a regression that
was introduced in v0.2.0 and persists through v0.2.7 (the latest at time of
writing; verified no fix in v0.2.8/0.2.9/0.2.10 either).

Usage:
    /Users/jleechan/.local/share/uv/tools/ccproxy-api/bin/python test-patches.py

Exit code:
    0 — all assertions pass (patch is applied; chain works end-to-end)
    1 — one or more assertions fail (patch missing or applied incorrectly)

Why this exists:
    The patch is applied to the ccproxy venv in place; if it gets dropped (e.g. by
    `uv tool install --upgrade ccproxy-api`) the chain silently regresses to 422 on
    every Anthropic /v1/messages request with thinking blocks. This script is the
    RED→GREEN test that proves the patch is present.

RED: stock 0.2.7 (RequestContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock)
     → assertion fails: "ThinkingBlock not in RequestContentBlock union"

GREEN: patched 0.2.7 (RequestContentBlock adds ThinkingBlock | RedactedThinkingBlock)
     → assertion passes
"""

from __future__ import annotations

import sys
import typing


def _resolve_inner_union(annotated_type: typing.Any) -> tuple[typing.Any, ...]:
    """Unwrap `Annotated[X, ...]` and return the inner union members as a tuple.

    ccproxy uses `Annotated[Union[..., ...], Field(discriminator="type")]`, so
    `typing.get_args(Annotated)` returns `(Union[...], Field(discriminator=...))`.
    The inner union is written as `X | Y` (PEP 604), which produces a
    `types.UnionType`, not `typing.Union` — both need to be handled.
    """
    import types as _types

    outer = typing.get_args(annotated_type)
    if not outer:
        return ()
    inner = outer[0]
    origin = typing.get_origin(inner)
    if origin is typing.Union or isinstance(inner, _types.UnionType):
        return typing.get_args(inner)
    # Already a tuple? (defensive)
    if isinstance(inner, tuple):
        return inner
    return (inner,)


def test_request_content_block_includes_thinking() -> None:
    """RequestContentBlock MUST include ThinkingBlock and RedactedThinkingBlock.

    Without these, ccproxy rejects every Anthropic /claude/v1/messages request
    whose messages[*].content contains a thinking block with HTTP 422, before
    the request reaches Anthropic.
    """
    # Import the ccproxy venv's anthropic models module from this script's directory.
    sys.path.insert(
        0,
        "/Users/jleechan/.local/share/uv/tools/ccproxy-api/lib/python3.11/site-packages",
    )
    try:
        from ccproxy.llms.models import anthropic  # type: ignore[import-not-found]
    except ImportError as exc:
        print(f"FAIL: cannot import ccproxy.llms.models.anthropic: {exc}")
        sys.exit(1)

    members = _resolve_inner_union(anthropic.RequestContentBlock)
    member_names = {m.__name__ for m in members if hasattr(m, "__name__")}

    required = {"ThinkingBlock", "RedactedThinkingBlock"}
    missing = required - member_names

    print(f"RequestContentBlock members: {sorted(member_names)}")
    if missing:
        print(f"FAIL: missing from RequestContentBlock: {sorted(missing)}")
        print("      ccproxy will reject any request with thinking content blocks.")
        print("      Apply scripts/ccproxy-patches/0001-RequestContentBlock-include-ThinkingBlock.patch")
        sys.exit(1)
    print("PASS: RequestContentBlock includes ThinkingBlock and RedactedThinkingBlock")


def test_response_content_block_still_includes_thinking() -> None:
    """ResponseContentBlock must STILL include ThinkingBlock (sanity check).

    This guards against a future ccproxy refactor that would accidentally drop
    thinking blocks from the response side too — which would break round-trip
    capture of Claude's thinking output.
    """
    sys.path.insert(
        0,
        "/Users/jleechan/.local/share/uv/tools/ccproxy-api/lib/python3.11/site-packages",
    )
    try:
        from ccproxy.llms.models import anthropic  # type: ignore[import-not-found]
    except ImportError as exc:
        print(f"FAIL: cannot import ccproxy.llms.models.anthropic: {exc}")
        sys.exit(1)

    members = _resolve_inner_union(anthropic.ResponseContentBlock)
    member_names = {m.__name__ for m in members if hasattr(m, "__name__")}

    required = {"ThinkingBlock", "RedactedThinkingBlock"}
    missing = required - member_names
    print(f"ResponseContentBlock members: {sorted(member_names)}")
    if missing:
        print(f"FAIL: missing from ResponseContentBlock: {sorted(missing)}")
        sys.exit(1)
    print("PASS: ResponseContentBlock includes ThinkingBlock and RedactedThinkingBlock")


def main() -> int:
    test_request_content_block_includes_thinking()
    test_response_content_block_still_includes_thinking()
    print()
    print("GREEN: all ccproxy schema tests pass — chain should work end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
