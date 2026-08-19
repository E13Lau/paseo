# User instruction files are a Host settings catalog

Status: accepted

Paseo edits each **User instruction file** in Host → Agents as **Instruction files**, not as a Workspace file tab and not through generic home-directory `fs.*`. The daemon exposes a feature-gated catalog plus read/write for those paths only (`provider.instruction_file.list|get|write`). An old client sees the capability as missing. The first catalog is Claude-family `CLAUDE.md` and Codex-family `AGENTS.override.md` or `AGENTS.md`, resolved from each listed provider's launch env (disabled included) and deduped by path. Saving writes the editor text, including empty; it creates a missing file and never deletes. Workspace file tabs cannot own a Host-scoped file, cannot edit source on mobile, and autosave the current file editor. Reusing `fs.*` with `cwd: "~"` would make the settings UI browse the home directory and freeze an unbounded path contract into the protocol.
