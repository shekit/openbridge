# Slash Commands

## `/project`

| Subcommand | Slack | Discord |
|------------|-------|---------|
| `new <name>` | `/project new my-app` | `/project new name:my-app` |
| `new /path` | `/project new /absolute/path` | `/project new name:/absolute/path` |
| `connect /path` | `/project connect /absolute/path` | `/project connect path:/absolute/path` |
| `connect` (no path) | Shows picker if root set | Shows button picker if root set |
| `list` | `/project list` | `/project list` |
| `disconnect` | `/project disconnect` | `/project disconnect` |
| `backend <name>` | `/project backend codex` | `/project backend name:codex` |

`new` creates the directory and binds the channel. If a project name (not an absolute path) is given, it's created under the projects root. If no root is set, use an absolute path or set one with `/settings root /path`.

Slack also supports `/project /absolute/path` (without `connect`) for backwards compatibility.

## `/settings`

| Subcommand | Slack | Discord |
|------------|-------|---------|
| (no args) | `/settings` — shows current settings | `/settings view` |
| Set projects root | `/settings root /path` | `/settings root path:/path` |

## `/new`

Resets the current session in a thread. Same on both platforms — must be used inside a thread.
