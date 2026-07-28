# Session analysis methodology

The initial design was based on pi sessions modified on local date 2026-07-27. Sessions below 200 KB, looop-related sessions, and the active analysis session were excluded.

Reproduce the aggregate analysis:

```sh
python3 scripts/analyze-sessions.py \
  --date 2026-07-27 \
  --exclude-session 019fa618-4a2a-71ec-a2af-9a56fb3f7261
```

The analyzer pairs assistant tool calls with `toolResult` messages by `toolCallId` and reports UTF-8 result bytes. It also computes the maximum direct saving from replacing only grep results above 8 KB with an 8 KB smart-result ceiling.

Observed during development:

- 19–20 qualifying sessions depending on whether still-running files were included
- `read`: about 1.6 MB across 342 calls in the stable 19-session sample
- `grep`: about 2.2 MB across 287 calls
- `babysit_check`: about 626 KB across 210 calls
- `ast_read_tree`: 76 calls / 426 KB in the broader top-20 sample
- `ast_read_symbol`: 160 calls / 799 KB
- Conservative estimated direct saving: roughly 1.3 MB, concentrated in oversized grep results

Representative live replay:

1. A recorded 51,248-byte explicit read of `crates/editor/src/interaction.rs` remains exact and is not blocked. An explicitly requested outline contains every symbol name and was 16,905 bytes (67% smaller); whole-file read receives the one-time outline nudge.
2. A broad Rust grep in the `rel-fix` workspace produced about 51 KB through built-in grep. Smart grep produced 2–3 KB (94% smaller), indexed every file represented in that exact run, and linked a byte-for-byte copy of the built-in result.

Quality checks are part of `index.test.ts`: exact read/grep parity, images, errors, truncation metadata, explicit ranges, all-file grep coverage or exact fallback, complete symbol-name coverage or full-outline fallback, and exact-result persistence.
