# Agent instructions

## Project overview

This repository (`whelp99-code-sangfor-engineer-mcp`) is a **minimal placeholder** used to verify GitHub write/upload access for a future **Sangfor Engineer MCP** integration. It does not contain application source, package manifests, containers, or CI workflows.

Tracked files:

- `README.md` — project title
- `README_FULL_SCOPE_UPLOAD_TEST.md` — temporary upload test marker

## Development commands

There are **no** install, lint, test, or build scripts in this repo. Standard commands do not apply until real MCP/service code is added.

| Task | Command |
|------|---------|
| Verify repo state | `git status` |
| List tracked files | `git ls-files` |
| Read project title | `cat README.md` |

## Cursor Cloud specific instructions

- **No services to start.** Nothing listens on a port; there is no database, Docker Compose stack, or dev server.
- **Update script:** The VM startup update step is a no-op (`true`) because there are no language runtimes or package managers to refresh.
- **Validation:** To confirm the environment works, run `git status` and `git ls-files` from `/workspace`. A successful clone with a clean or expected working tree indicates the environment is ready for future code drops.
- **When real code lands:** Add the appropriate manifest (`package.json`, `pyproject.toml`, etc.), document install/lint/test/run commands here, and replace the update script with the real dependency refresh command (for example `npm ci` or `uv sync`).
