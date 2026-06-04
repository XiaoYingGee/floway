# Deployment — CI/CD to the self-hosted VM

This documents the automated pipeline. For the local/manual Docker workflow see
[README.md](./README.md). The pipeline only ever touches files this package owns
(`apps/server/`, `.github/workflows/`), so it stays merge-safe with upstream.

## Branch model

| Branch | Role | Rules |
| --- | --- | --- |
| `main` | **Pure upstream mirror.** | Only `git merge --ff-only origin/main`. Never carries `apps/server/`, workflows, or any personal code. |
| `personal` | **Integration line.** Upstream + this package + workflows + personal patches (e.g. the UnoCSS web-fonts fix). | Pushed directly. A push runs CI. |
| `deployment` | **Release line.** What is deployed. | Protected: PR-only, required status check `check`. A merge (= push) triggers `Deploy`. |

## Everyday flows

**Ship a change**
1. Branch off `personal`, or commit to `personal`, and push.
2. Open a PR `personal → deployment`. CI `check` (typecheck + web/server build) gates it.
3. Merge → `Deploy` builds the image, pushes it to GHCR, and redeploys the VM.

**Absorb an upstream update**
```bash
git checkout main && git merge --ff-only origin/main   # keep main a clean mirror
git checkout personal && git merge main                # resolve any conflicts HERE
git push origin personal                               # CI validates the integration
```
Then open a PR `personal → deployment` and merge to release. Personal code never
flows back into `main`.

## What the pipeline does (`.github/workflows/deploy.yml`)

1. **build-and-push** (GitHub-hosted): builds the image from the repo root
   (`-f apps/server/Dockerfile`) and pushes `ghcr.io/xiaoyinggee/floway:latest`
   and `:<sha>`.
2. **deploy** (over SSH to the VM): updates the VM's checkout to the deployed
   commit and restarts:
   - `git fetch` the `deployment` commit into `~/codebase/floway` using the
     run-scoped `GITHUB_TOKEN` (no long-lived creds persist on the VM);
   - `docker compose pull && up -d` from `apps/server/`, which auto-merges
     `docker-compose.yml` + the host-specific `docker-compose.override.yml`.

`ci.yml` runs the same build/typecheck on push to `personal` and on PRs into
`deployment`.

## VM runtime facts

- **Image**: the base `docker-compose.yml` takes `FLOWAY_IMAGE`; the pipeline
  pins it to the CI-built `ghcr.io/xiaoyinggee/floway:<sha>`. Locally, unset, it
  builds and tags `floway`.
- **Networking**: `docker-compose.override.yml` on the VM binds the service to
  **loopback only** — `127.0.0.1:18788 -> 8788`. It is *not* publicly exposed;
  reach it via an SSH tunnel: `ssh -L 18788:127.0.0.1:18788 <vm>`. This override
  lives on the VM (untracked) and survives every deploy.
- **State**: persists in the bind mount `/data/floway` (`floway.db` + `files/`).
  Container restarts and image swaps never touch it. Upstream D1 migrations
  auto-apply on boot (tracked in `_server_migrations`).
- **Health**: `curl http://127.0.0.1:18788/api/health` → `{"status":"ok",...}`;
  the image also has a Docker `HEALTHCHECK`.

## GitHub repo secrets

| Secret | Value |
| --- | --- |
| `SSH_HOST` | VM public IP / host reachable from GitHub Actions |
| `SSH_USER` | deploy user |
| `SSH_PORT` | SSH port (optional, defaults to 22) |
| `SSH_KEY` | private half of a dedicated deploy key; public half in the VM user's `~/.ssh/authorized_keys` |
| `ADMIN_KEY` | dashboard/control-plane admin key, injected at deploy |

GHCR auth needs no extra secret: the same run-scoped `GITHUB_TOKEN` logs in to
GHCR on the VM for the duration of the deploy.

## Manual redeploy & rollback

- **Redeploy current `deployment`**: run the `Deploy` workflow via
  *workflow_dispatch*.
- **Roll back**: every build is tagged with its commit `:<sha>` and retained in
  GHCR. On the VM, pin a previous image and restart:
  ```bash
  cd ~/codebase/floway/apps/server
  FLOWAY_IMAGE=ghcr.io/xiaoyinggee/floway:<old-sha> ADMIN_KEY=… docker compose up -d
  ```
  Or revert `deployment` to a prior commit via PR, which redeploys it.

## First-deploy note

The very first pipeline deploy adopts a `floway` container that was created
out-of-band; the deploy job force-removes it on a name conflict and retries
(state is in the `/data/floway` bind mount, so nothing is lost). Subsequent
deploys are compose-managed and recreate in place.
