# /skillcount — Skill Usage Audit

Count how often each skill is actually used across Claude Code, Codex, and Hermes, then cross-reference against installed skills to find unused ones.

## Key Insights (learned 2026-06-13)

**Three runtimes, three different storage formats:**
- **Claude Code** — `~/.claude/projects/*/*.jsonl` — skills read via `Read` tool, path in `file_path`
- **Codex** — `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl` — skills read via `exec_command` with shell `cat`/`read` — format: `response_item` with `type=function_call`, `name=exec_command`, `arguments` JSON containing `command` string
- **Hermes** — `~/.hermes/sessions/*.jsonl` — skills mentioned in message text (low signal)

**Skills are read from many path roots, not just `~/.claude/skills/`:**
- `~/.claude/skills/<name>/SKILL.md` or `~/.claude/skills/<name>.md`
- `~/.claude/commands/<name>.md`
- `~/projects/worktree_*/.claude/skills/<name>/SKILL.md`
- `~/.worktrees/*/.claude/skills/<name>/SKILL.md`
- `~/projects/worldarchitect.ai/.claude/skills/<name>/SKILL.md`
- `~/.hermes/skills/**/<name>/SKILL.md`
- Repo-local `.claude/commands/<name>.md` in any worktree

**Extract skill name from any path** by matching the last `/`-delimited component before `SKILL.md` or the filename stem before `.md` in a `commands/` or `skills/` directory.

## Step 1 — Claude Code scan (Read tool)

```bash
touch -t $(date -v-14d +%Y%m%d0000) /tmp/skillcount_since 2>/dev/null || \
  touch -d "14 days ago" /tmp/skillcount_since

find ~/.claude/projects/ -name "*.jsonl" -newer /tmp/skillcount_since 2>/dev/null | \
  xargs python3 -c "
import json, sys, fileinput, re

counts = {}
# Match skill name from any path containing skills/ or commands/ .md
skill_re = re.compile(r'/skills/([^/]+)/SKILL\.md|/(?:skills|commands)/([^/\.]+)\.md\b')

for line in fileinput.input(sys.argv[1:], openhook=open, errors='ignore'):
  try:
    obj = json.loads(line)
    if obj.get('type') != 'assistant': continue
    for block in (obj.get('message',{}).get('content') or []):
      if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Read':
        path = (block.get('input') or {}).get('file_path','')
        m = skill_re.search(path)
        if m:
          skill = m.group(1) or m.group(2)
          counts[skill] = counts.get(skill, 0) + 1
  except: pass

import json as j
print(j.dumps(counts))
" 2>/dev/null > /tmp/skill_cc_counts.json
echo 'Claude Code done'
```

## Step 2 — Codex scan (exec_command)

```bash
find ~/.codex/sessions/ ~/.codex/archived_sessions/ \
  -name "*.jsonl" -newer /tmp/skillcount_since 2>/dev/null | \
  xargs python3 -c "
import json, sys, fileinput, re

counts = {}
skill_re = re.compile(r'/skills/([^/\s\"]+)/SKILL\.md|/(?:skills|commands)/([^/\s\"\.]+)\.md')

for line in fileinput.input(sys.argv[1:], openhook=open, errors='ignore'):
  try:
    obj = json.loads(line)
    payload = obj.get('payload', {})
    if not isinstance(payload, dict): continue
    if payload.get('type') == 'function_call' and payload.get('name') == 'exec_command':
      args = json.loads(payload.get('arguments','{}'))
      cmd = args.get('command','')
      for m in skill_re.finditer(cmd):
        skill = m.group(1) or m.group(2)
        counts[skill] = counts.get(skill, 0) + 1
  except: pass

import json as j
print(j.dumps(counts))
" 2>/dev/null > /tmp/skill_codex_counts.json
echo 'Codex done'
```

## Step 3 — Merge and cross-reference

```python
import json, os

cc    = json.load(open('/tmp/skill_cc_counts.json'))
codex = json.load(open('/tmp/skill_codex_counts.json'))

# Merge
merged = {}
for k, v in cc.items():    merged[k] = merged.get(k,0) + v
for k, v in codex.items(): merged[k] = merged.get(k,0) + v

# Load installed skill names from ~/.claude/skills/
skills_path = os.path.expanduser('~/.claude/skills')
skill_names = set()
for entry in os.listdir(skills_path):
  if entry.startswith('_'): continue
  full = os.path.join(skills_path, entry)
  if os.path.isdir(full):
    skill_names.add(entry)
  elif entry.endswith('.md'):
    skill_names.add(entry[:-3])

never  = sorted(s for s in skill_names if merged.get(s, 0) == 0)
used   = [(s, merged[s]) for s in skill_names if merged.get(s, 0) > 0]

print(f'Total installed: {len(skill_names)}')
print(f'Used (14d): {len(used)}')
print(f'Unused (14d): {len(never)}')
print()
print('=== USED (sorted by count) ===')
for s, c in sorted(used, key=lambda x: -x[1]):
    print(f'  {c:5d}  {s}')
print()
print('=== UNUSED (14d) ===')
for s in never:
    print(f'         {s}')
```

## Notes

- Codex counts are much higher (2000+) because AO workers run many sessions and each reads skills fresh
- A skill at 0 reads in 14d may still be genuinely used — check longer window with `date -v-90d`
- Symlinked skills (`dark-factory`, `pr-green-definition`, `domain-lock`) resolve to their target path — the skill name still matches
- Hermes skills live at `~/.hermes/skills/` — add that path to the scan if needed
- cmux/wiki skills ARE used by Hermes/Codex — absence from Claude Code scan means they're invoked from those runtimes, not that they're unused

## Archive pattern

```bash
# Move to global archive
mv ~/.claude/skills/<name> ~/.claude/skills/_archive/
mv ~/.claude/skills/<name>.md ~/.claude/skills/_archive/

# Move to repo-specific archive  
mv ~/.claude/skills/<name> ~/projects/worldarchitect.ai/.claude/skills_archive/
```

The `_archive/` dir is excluded from skill listing (prefix `_`).
