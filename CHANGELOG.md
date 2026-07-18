# Change Log

All notable changes to the "ocursor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.6] - 2026-07-18

### Added

- Subagents inherit the main agent's context-size limit (auto-compaction applies)
- Expandable, collapsed-by-default task prompt inside the subagent chat view

### Fixed

- Delete tool timing out but not stopping (abort-aware `unlink`/backup read)
- Read supports paths with spaces; directory paths return a clear error
- Chat scrolls to the very bottom when returning to the main agent (tab switch / Back)

### Removed

- Outer timeout budget on subagent Tasks (nested tools already have their own timeouts)

### Changed

- TodoWrite / TodoRead timeout tripled
- Tool outputs trimmed to send fewer tokens to the model (only tools; prompts unchanged)
- Shell result drops pid/running-for/echoed-command header when done; middle-truncated 12k body with collapsed blank lines
- Read caps whole-file reads at 1500 lines with a continue hint (was uncapped)
- ListDir caps at 300 entries (dirs first) with a "more" hint
- SemanticSearch returns 8 hits (was 12), each chunk snippet-capped at 1200 chars
- SearchDocs excerpts snippet-capped at 1200 chars
- Grep abort/timeout output cap 50k → 12k

## [0.0.5] - 2026-07-15

### Added

- Live timeout countdown badges on tools/tasks; kill at zero via host abort
- Shell tool card redesign: full command wrap, meta/body/footer, copy-command button
- Hard budgets for foreground/background subagents so Tasks cannot hang forever
- Stream coalescing for high-frequency agent/UI events (text/thinking/tool args)
- Read tool wall-clock timeouts (`stat` + I/O) and abort-aware path access
- Path normalizer for spaces, quotes, `file://` URIs, and mixed separators

### Fixed

- Tools stuck “Working” after timeout (immediate UI settle + cancel path)
- Read hanging on missing/unreachable/network paths (timeout could not terminate)
- Shell stuck on paths with spaces; PowerShell framing + session queue races
- Invalid path throws in Read/ListDir/Glob and related tools (user-friendly errors)
- Directory paths on Read return a clear error (suggest ListDir/Glob)
- UI freezes from high-frequency stream postMessage / React re-renders
- Read-only tools thrashing CPU/IO when many run in parallel (concurrency cap)

### Changed

- TodoWrite / TodoRead default timeout 5s → 15s
- Read default timeout tightened to match inner I/O budget
- Task tool included in configurable timeouts with countdown UI

## [0.0.4] - 2026-07-15

### Added

- Per-tool hard timeouts so hung Grep/Glob/Shell/etc. cannot block the agent loop forever
- Abort-signal support for long-running tools (walk, grep, shell) so Stop cancels mid-work
- Configurable per-tool timeout seconds in Settings → Agents
- GPU-accelerated local embeddings when available (DirectML / CUDA / CoreML / WebGPU), with CPU fallback
- Indexing page shows GPU/CPU badge plus model and runtime technical details (repo, dtype, ONNX EP, platform)
- Stricter indexable-file filters (source extensions only; skip lockfiles, minified bundles, binaries)

### Changed

- Expanded ignored directories for tools and indexing (`node_modules`, build caches, venvs, vendor, etc.)
- Semantic index walk and file watcher skip non-source trees earlier for faster indexing

## [0.0.3] - 2026-07-15

### Added

- Indexing enable/disable toggle in settings (fully turns off semantic indexing)
- Persistent semantic index across VS Code restarts (warm load from disk)
- Incremental re-index of only changed files on sync/reopen
- Real-time auto-index of new/modified files via workspace file watcher
- Context size dropdown beside the model picker for models without catalog presets
- Default context options (`32k`–`1m`) injected for uncatalogued models

### Changed

- Smart conversation summarization triggers at 80% of the usable context budget
- Subagents run with isolated history (empty parent context); parent only receives the final Task result
- Multitask/background Task waves wait for completion before the parent continues
- Stop/cancel aborts all linked subagents and force-settles open tools, thinking, and compaction UI

### Fixed

- Stuck “working” subagent spinners and unresponsive stop in multitask mode
- Orphaned shell processes when a run is aborted mid-command
- Context ring default aligned with resolved `max_context` (fallback `128k`)

## [0.0.2] - 2026-07-05

### Added

- Per-workspace conversations (existing global conversations migrate automatically)
- GGUF models auto-load on first message with a "loading model" card in chat
- llama.cpp server uses random free ports with retry on bind failure

### Changed

- Composer dropdowns (model picker, mode menu) now position themselves within the viewport and work in edit mode
- All composers share one selected model and mode
- Auto model selection hidden for now; first enabled model is the default

### Fixed

- Production error: `Cannot find package '@huggingface/hub'` (runtime deps now resolved via file URLs)

### Removed

- MCP tool marketplace

## [0.0.1] - 2026-07-05

### Added

- Initial release
- Agent chat sidebar with multi-turn conversations and streaming responses
- Tool suite: file read/write/edit, glob/grep search, shell commands, web search/fetch
- Local model providers: Ollama and llama.cpp, plus OAuth-based cloud providers
- Semantic codebase index for meaning-based search
- MCP (Model Context Protocol) client with external server support
- Approval policy engine with allow/ask/deny rules per tool (shell, edits, web, MCP)
- Inline diff review for AI-proposed edits
- Context mentions, workspace context, and custom rules/hooks
- Settings panel (React webview) for models, features, and approval configuration
- `Ctrl+L` / `Cmd+L` to add editor selection to chat
