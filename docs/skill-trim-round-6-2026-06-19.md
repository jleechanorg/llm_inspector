# Skill Trim Round 6 — 2026-06-19

Audit of user-scope skill directories after rounds 1-5b (which moved `~/.codex/skills/` →
`~/.agents/skills/` and archived 152 source-command-* + 14 superpowers-* + 1 mvp_site orphan).

Branch: `skills_clean` (off `main` @ `0d3efa0`)
Audit date: 2026-06-19
Tools: `du`, custom 30-day `/skillcount` (Claude Code + Codex JSONL scan)

## Current state

| Directory | Entries | Size | Role |
|-----------|--------:|-----:|------|
| `~/.agents/skills/` | 129 (+ `_archive/`) | 2.8M | Codex canonical (r0) |
| `~/.claude/skills/` | 126 (+ `_archive/`) | 362M | Claude Code canonical |
| `~/.codex/skills/` | 10 (+ tombstone) | 472K | Round-4 mirror (still alive) |
| `~/.codex-archive-2026-06-13/` | 188 in snapshot | 1.1M | Round-4 backup |
| `~/.agents-archive-2026-06-14-trim5b/` | 17 | 290K | Round-5b backup |
| `~/.codex/superpowers/skills/` | 14 (no prefix) | (n/a) | Canonical superpowers (9th root) |

**30-day skillcount:** 110 of 181 active; 71 never-invoked in 30d.

## Findings

### Finding 1 — 358M node_modules bloat in archived excalidraw-diagram (BIGGEST WIN)

`~/.claude/skills/_archive/excalidraw-diagram/references/node_modules/` = **358M**.

The skill's own README says: *"Just tell your agent: 'Set up the Excalidraw diagram skill
renderer by following the instructions in SKILL.md.'"* — i.e. the renderer deps are
installed **fresh** via `npm install` / `uv sync` when needed, NOT shipped with the skill.

The 358M is `mermaid` (87M) + `@excalidraw` (48M) + `es-toolkit` (13M) + 9 other packages.

The actual skill content (SKILL.md, color-palette.md, json-schema.md, render_excalidraw.py,
package.json, uv.lock) is **~50K total**. The node_modules got committed by accident
during archival on 2026-06-07.

### Finding 2 — Round-4 plan partially executed: `~/.codex/skills/` still has 10 redundant entries

The plan at `~/.claude/plans/groovy-booping-rabin.md` (round 4) said: migrate 8
codex-only skills to `~/.agents/skills/`, then archive `~/.codex/skills/`. The migration
happened, but the live `~/.codex/skills/` was never removed (only an `ARCHIVED-2026-06-13.txt`
tombstone was added).

Current 10 entries:
| Skill | In `~/.claude/skills/`? | In `~/.agents/skills/`? | Action |
|-------|:---:|:---:|---|
| agent-orchestrator | DEAD symlink | ✓ (canonical) | safe to remove |
| babysit | ✓ (canonical) | ✗ | safe to remove |
| codex-evolve-loop | DEAD symlink | ✓ (canonical) | safe to remove |
| evidence-standards | ✓ | ✓ | safe to remove |
| pr-driver-protocol | ✓ (canonical) | ✗ | safe to remove |
| pr-green-definition | DEAD symlink | ✓ (canonical) | safe to remove |
| skeptic-agent | ✓ | ✓ | safe to remove |
| tdd-evidence-workflow | DEAD symlink | ✗ | **MIGRATE first** |
| technique-router | DEAD symlink | ✗ | **MIGRATE first** |
| tmux-video-evidence | ✓ | ✓ | safe to remove |

**2 need migration** before removal: `tdd-evidence-workflow`, `technique-router`.

### Finding 3 — 4 dead symlinks in `~/.claude/skills/` pointing to gone worktree

```
agent-orchestrator     → /Users/jleechan/.worktrees/agent-orchestrator/ao-6385/skills/agent-orchestrator/  (worktree gone)
codex-evolve-loop      → .../ao-6385/skills/codex-evolve-loop/       (worktree gone)
pr-green-definition    → .../ao-6385/skills/pr-green-definition/     (worktree gone)
tdd-evidence-workflow  → .../ao-6385/skills/tdd-evidence-workflow/   (worktree gone)
technique-router       → .../ao-6385/skills/technique-router/        (worktree gone)
```

But all 5 have working copies in `~/.agents/skills/`. So removal is safe.

### Finding 4 — 5 byte-identical cross-dir duplicates (NOT symlinks)

These are real copies of the same SKILL.md content in both `~/.claude/skills/` AND
`~/.agents/skills/`:

- `ao-spawn-gate`
- `design`
- `karpathy-wiki`
- `pr-blocker-min-repro`
- `streaming-evidence-standards`

(`bead-followup-templates` is also byte-identical but it's already a symlink in agents
pointing to claude — not a duplicate, just a cross-root link.)

### Finding 5 — 71 never-invoked skills in 30 days

Round 5b learned that 14d window is too short for monthly/quarterly skills. 30d finds 71
(total 0.7M disk). Top by size:

| Size | Skill | Notes |
|------|-------|-------|
| 253K | claude-api | Reference docs — used when needed |
| 184K | cmux-codex-autoapprove | cmux config |
| 22K | superpowers-writing-skills | From round-5b canonical |
| 22K | internal-comms | Quarterly comm templates |
| 16K | skillify | Only when authoring new skills |
| 12K | codex-loop | Codex-only loop skill |
| 9K | superpowers-systematic-debugging | In `~/.claude/skills/`, never invoked |

**None are obvious orphans.** All have legitimate monthly/quarterly use patterns.

## Proposed trim actions

### Tier 1 — Safe wins (recommend execute)

| # | Action | Saving | Risk |
|---|--------|-------:|:---:|
| 1.1 | Backup `~/.claude/skills/_archive/excalidraw-diagram/references/node_modules/` → `~/.claude/skills/_archive/_removed-2026-06-19/excalidraw-node_modules.bak/`, then remove | **~358M** | very low (renderer re-installs deps) |
| 1.2 | Backup `~/.codex/skills/` → `~/.codex-archive-2026-06-19/codex-skills-final/`, then `rm -rf ~/.codex/skills/` | 472K + 10 entries | low (8/10 redundant; 2 need migration) |
| 1.3 | Migrate `tdd-evidence-workflow` and `technique-router` from `~/.codex/skills/` → `~/.agents/skills/` BEFORE 1.2 | (no savings) | low |
| 1.4 | Remove 4 dead symlinks in `~/.claude/skills/` (agent-orchestrator, codex-evolve-loop, pr-green-definition, tdd-evidence-workflow, technique-router) | 0 | very low (working copies exist in agents/skills) |

### Tier 2 — Cross-dir dedup (requires explicit "ok change it")

| # | Action | Saving | Risk |
|---|--------|-------:|:---:|
| 2.1 | Archive 5 byte-identical cross-dir dups from `~/.agents/skills/` (ao-spawn-gate, design, karpathy-wiki, pr-blocker-min-repro, streaming-evidence-standards). Keep `~/.claude/skills/` versions. | ~50K + 5 entries | low |

### Tier 3 — Not recommended without per-skill review

| # | Action | Notes |
|---|--------|-------|
| 3.1 | Archive 71 never-invoked-30d | Most are monthly/quarterly; archive individual only |
| 3.2 | 378 worktree `.codex/skills/` dedup | Out of scope (per-worktree, large blast radius) |
| 3.3 | Plugin cache skills (r2-r7) | Different problem, separate decision |

## Cumulative trim delta

After Tier 1:
- Disk: 362M → 4M in `~/.claude/skills/_archive/` (98.9% reduction)
- Codex block: 10 redundant codex/skills entries removed (155 → 145)
- Skills block tokens: ~6,107 → ~5,400 (estimate)

After Tier 1 + Tier 2:
- Codex block: 145 → 140 entries

After Tier 3 (per-skill only): variable
