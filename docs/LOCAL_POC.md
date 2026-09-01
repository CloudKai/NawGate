# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Agent turn in a disposable Docker, Colima, or Podman container.
The current Agent Runtime adapter is Codex CLI; only the selected Ark or
OpenAI-compatible model API is remote. Codex is the Launchpad's current Runtime,
not an architectural dependency of NawGate.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- An Ark or OpenAI-compatible API key and Responses-capable model

Copy and edit the safe template:

```bash
test -f .env || cp .env.example .env
openssl rand -hex 24
```

Paste the generated value into `APP_AUTH_TOKEN`, then fill exactly one provider
section.

Ark:

```dotenv
MODEL_PROVIDER=ark
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
```

OpenAI-compatible:

```dotenv
MODEL_PROVIDER=openai-compatible
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=your-responses-capable-model-id
OPENAI_BASE_URL=https://api.openai.com/v1
```

Load the file and start the complete POC:

```bash
set -a
source .env
set +a
npm run poc
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Leave `APP_DATA_DIR`, `AGENT_WORKSPACE_ROOT`, `CODEX_HOME`,
`NAWGATE_GATEWAY_URL`, `CONTAINER_ENGINE`, and `RUNTIME_INSTANCE_ID` commented
unless intentionally overriding them. The POC selects safe host paths, a
container-reachable gateway, an available engine, and an instance-specific ID.
Codex CLI and `agentctl` are already installed in the Runtime image; no host
Codex installation is required.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
set -a
source .env
set +a
CONTAINER_ENGINE=podman npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
set -a
source .env
set +a
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

If startup tries to create `/app` or the Runtime cannot reach
`http://127.0.0.1:3000`, the local `.env` predates the safe template. Remove or
comment the active `/app` path variables and `NAWGATE_GATEWAY_URL`; those values
are selected automatically for the POC.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
