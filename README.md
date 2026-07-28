# pi-skim

Quality-preserving, context-efficient reading for [pi](https://pi.dev).

`pi-skim` takes over the existing `read` and `grep` names. It preserves pi's exact read implementation as the default, folds the main `pi-ast-read` workflow into optional `read` actions, and turns only oversized grep results into bounded cross-file indexes. It does not intercept pi-babysit logs.

## Safety model

The extension never automatically summarizes or deletes an executed exact result.

- `read` with no `action`, or with `action=exact`, delegates unchanged to pi's built-in read implementation.
- Large whole-source reads receive a **one-time nudge** toward an outline/symbol. Explicit ranges always remain exact. Repeating the whole-file call bypasses the nudge.
- Grep results up to 8KB delegate unchanged to pi's built-in grep. Larger results become a file index only when every returned file path fits; the byte-for-byte exact result is saved and linked, and `mode=exact` bypasses indexing.
- Optimized output always has an explicit byte budget and points to exact fallback when truncated.
- Unsupported AST languages fail clearly; exact read remains available.

This is progressive disclosure, not lossy post-processing.

## Tool surface

`pi-skim` keeps the existing `read` name and adds optional actions:

| Call | Behavior |
|---|---|
| `read({ path })` | Exact pi built-in read |
| `read({ path, offset, limit })` | Exact pi built-in line range |
| `read({ path, action: "outline" })` | Symbol signatures and line ranges, without bodies |
| `read({ path, action: "symbol", symbol })` | One named function/class/method/target |
| `read({ path, action: "focus", pattern })` | Bounded regex windows within one file |

After removing the old `pi-ast-read` package, its two schemas are replaced by these `read` actions. `pi-skim` does not forcibly deactivate a co-loaded package because its old read hook could otherwise point at inactive tools during migration.

`grep` keeps the existing parameters and adds:

| Call | Behavior |
|---|---|
| `grep({ pattern, ... })` | Exact built-in result when ≤8KB; otherwise bounded file index plus exact-output path |
| `grep({ pattern, mode: "exact", ... })` | Exact pi built-in grep result |
| `grep({ pattern, maxBytes, maxPerFile, ... })` | Configure smart-index budget and representative matches; activation remains fixed at 8KB |

## Why

A sample of 19 large, non-looop pi sessions from one workday contained:

| Tool | Calls | Result bytes |
|---|---:|---:|
| `read` | 342 | 1.59 MB |
| `grep` | 287 | 2.21 MB |
| `babysit_check` | 210 | 626 KB |
| `ast_read_tree` | 76 | 426 KB |
| `ast_read_symbol` | 160 | 799 KB |

Recurring problems were whole or very large source reads, broad grep with large context, and a fragmented AST/read tool surface. Log analysis showed too little additional upside beyond pi-babysit's existing cap, so log behavior is intentionally left unchanged.

In the same-day replay, 180 broad grep calls produced 2.15MB. An 8KB smart-result ceiling would reduce those results to about 810KB—a maximum direct saving of 1.34MB (62%)—without extra blocked tool turns.

## Usage

### Exact read — unchanged

```json
{
  "path": "src/server.ts",
  "offset": 200,
  "limit": 120
}
```

### Outline then read one symbol

```json
{
  "path": "src/server.ts",
  "action": "outline"
}
```

```json
{
  "path": "src/server.ts",
  "action": "symbol",
  "symbol": "Server.handleRequest"
}
```

If detailed signatures exceed the outline budget, the compact view still includes every symbol name and range and links the full detailed outline. If even all names cannot fit, pi-skim returns the full outline rather than hiding symbols.

### Focused windows

```json
{
  "path": "src/server.ts",
  "action": "focus",
  "pattern": "retry|timeout",
  "context": 3,
  "maxMatches": 12,
  "maxBytes": 8000
}
```

## Supported outline languages

Backed by [`ast-grep`](https://ast-grep.github.io/):

- Rust
- TypeScript / TSX
- JavaScript / JSX
- Python
- Shell
- Makefiles (built-in parser)

```sh
brew install ast-grep
```

## Nudge and indexing behavior

Read nudges:

| Guardrail | Threshold |
|---|---:|
| Whole supported source read | 20 KB |

Explicit and open-ended ranges are never nudged. Every whole-file nudge is keyed by the exact request and fires once per session. Repeating the same call runs unchanged. Grep does not use a blocking nudge: it executes once and indexes only when the exact result exceeds 8KB.

Environment variables:

| Variable | Meaning |
|---|---|
| `PI_SKIM_NUDGE=0` | Disable read nudges |
| `PI_SKIM_NUDGE_BYTES` | Whole-source threshold |

## Install

Local development:

```sh
pi -e ~/projects/pi-skim
```

When enabling permanently, remove `pi-ast-read` so its old tools and nudge are not loaded alongside `pi-skim`:

```sh
pi remove npm:@yusukeshib/pi-ast-read
pi install npm:@yusukeshib/pi-skim@0.x
```

## Development

```sh
npm install
npm run check
```

The test suite verifies exact built-in read/grep parity, one-time read bypass behavior, AST navigation, bounded grep indexing, byte-for-byte exact-result preservation, and that pi-babysit calls are untouched.
