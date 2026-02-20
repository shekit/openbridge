# Slash Commands

## `/project`

| Subcommand | Slack | Discord |
|------------|-------|---------|
| `connect /path` | `/project connect /absolute/path` | `/project connect path:/absolute/path` |
| `connect` (no path) | Shows picker if root set | Shows button picker if root set |
| `list` | `/project list` | `/project list` |
| `disconnect` | `/project disconnect` | `/project disconnect` |

Slack also supports `/project /absolute/path` (without `connect`) for backwards compatibility.

## `/settings`

| Subcommand | Slack | Discord |
|------------|-------|---------|
| (no args) | `/settings` — shows current settings + usage | `/settings` |
| Switch backend | `/settings backend codex` | `/settings args:backend codex` |
| Set projects root | `/settings root /path` | `/settings args:root /path` |

## `/new`

Resets the current session in a thread. Same on both platforms — must be used inside a thread.
