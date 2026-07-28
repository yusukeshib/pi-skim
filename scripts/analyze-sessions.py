#!/usr/bin/env python3
"""Measure read/grep/AST/log context pressure in pi JSONL sessions."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
from typing import Any

TOOLS = (
    "read",
    "grep",
    "ast_read_tree",
    "ast_read_symbol",
    "babysit_check",
    "get_search_content",
)


def text_content(message: dict[str, Any]) -> str:
    return "".join(
        block.get("text", "")
        for block in message.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    )


def local_day_start(day: str | None) -> float:
    if day:
        date = dt.date.fromisoformat(day)
    else:
        date = dt.datetime.now().astimezone().date()
    local = dt.datetime.combine(date, dt.time.min).astimezone()
    return local.timestamp()


def parse_session(path: Path) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any], str]]]:
    calls: dict[str, tuple[str, dict[str, Any]]] = {}
    results: list[tuple[str, dict[str, Any], str]] = []
    header: dict[str, Any] = {}
    with path.open(errors="replace") as stream:
        for index, raw in enumerate(stream):
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if index == 0 and entry.get("type") == "session":
                header = entry
            if entry.get("type") != "message":
                continue
            message = entry.get("message") or {}
            if message.get("role") == "assistant":
                for block in message.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        calls[block.get("id")] = (
                            block.get("name", ""),
                            block.get("arguments") or {},
                        )
            elif message.get("role") == "toolResult":
                call = calls.get(message.get("toolCallId"))
                if call:
                    results.append((call[0], call[1], text_content(message)))
    return header, results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.home() / ".pi/agent/sessions")
    parser.add_argument("--date", help="Local date, YYYY-MM-DD (default: today)")
    parser.add_argument("--min-bytes", type=int, default=200_000)
    parser.add_argument("--include-looop", action="store_true")
    parser.add_argument(
        "--exclude-session",
        action="append",
        default=[],
        help="Session UUID substring to exclude (repeatable)",
    )
    args = parser.parse_args()

    start = local_day_start(args.date)
    excluded_sessions = set(args.exclude_session)
    if os.environ.get("PI_SESSION_ID"):
        excluded_sessions.add(os.environ["PI_SESSION_ID"])
    sessions: list[tuple[Path, dict[str, Any], list[tuple[str, dict[str, Any], str]]]] = []
    for path in args.root.rglob("*.jsonl"):
        file_stat = path.stat()
        if file_stat.st_mtime < start or file_stat.st_size < args.min_bytes:
            continue
        if any(session in path.name for session in excluded_sessions):
            continue
        header, results = parse_session(path)
        cwd = str(header.get("cwd", ""))
        if not args.include_looop and "looop" in f"{cwd} {path}".lower():
            continue
        sessions.append((path, header, results))

    calls: collections.Counter[str] = collections.Counter()
    result_bytes: collections.Counter[str] = collections.Counter()
    grep_oversized: list[int] = []
    read_without_range = 0
    read_without_range_bytes = 0
    repeated_read_bytes = 0
    seen_reads: dict[tuple[str, str], str] = {}

    for path, _header, results in sessions:
        for tool, tool_args, text in results:
            if tool not in TOOLS:
                continue
            size = len(text.encode())
            calls[tool] += 1
            result_bytes[tool] += size
            if tool == "grep" and size > 8_000:
                grep_oversized.append(size)
            if tool == "read":
                if "offset" not in tool_args and "limit" not in tool_args:
                    read_without_range += 1
                    read_without_range_bytes += size
                key = (str(path), json.dumps(tool_args, sort_keys=True, ensure_ascii=False))
                digest = hashlib.sha256(text.encode()).hexdigest()
                if seen_reads.get(key) == digest:
                    repeated_read_bytes += size
                else:
                    seen_reads[key] = digest

    report = {
        "date": args.date or dt.datetime.now().astimezone().date().isoformat(),
        "sessions": len(sessions),
        "sessionBytes": sum(path.stat().st_size for path, _, _ in sessions),
        "tools": {
            tool: {"calls": calls[tool], "resultBytes": result_bytes[tool]}
            for tool in TOOLS
        },
        "grepOver8KB": {
            "calls": len(grep_oversized),
            "resultBytes": sum(grep_oversized),
            "eightKBCeilingBytes": sum(min(size, 8_000) for size in grep_oversized),
            "maximumDirectSavingsBytes": sum(max(0, size - 8_000) for size in grep_oversized),
        },
        "readWithoutRange": {
            "calls": read_without_range,
            "resultBytes": read_without_range_bytes,
        },
        "exactRepeatedReadBytes": repeated_read_bytes,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
