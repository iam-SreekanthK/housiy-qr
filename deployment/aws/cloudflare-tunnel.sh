
#!/usr/bin/env bash
# Housiy Cloudflare Quick Tunnel installer
# Features:
#   - Installs cloudflared on Ubuntu/Debian
#   - Supports .env.dev, .env.uat, and .env.prod
#   - Runs as a systemd service in the background
#   - Automatically starts after server reboot
#   - Automatically restarts if cloudflared crashes
#   - Prints and saves the public URL
#   - Maintains logs and service status
#
# Usage:
#   ./aws/cloudflare-service.sh
#   ./aws/cloudflare-service.sh .env.dev
#   ./aws/cloudflare-service.sh .env.uat
#   ./aws/cloudflare-service.sh .env.prod
#   ./aws/cloudflare-service.sh /path/to/.env.dev

set -Eeuo pipefail

# ------------------------------------------------------------
# Resolve directories and environment
# ------------------------------------------------------------

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DOCKER_DIR="$ROOT/deployment/docker"

ENV_ARG="${1:-.env.dev}"
ENV_BASE="$(basename "$ENV_ARG")"

case "$ENV_BASE" in
    .env.dev|.env.uat|.env.prod)
        ENV_FILE="$DOCKER_DIR/$ENV_BASE"
        ;;
    *)
        echo "Usage: $0 [.env.dev|.env.uat|.env.prod|/path/to/.env.dev]" >&2
        exit 2
        ;;
esac

if [[ "$ENV_ARG" == */* ]]; then
    [[ -f "$ENV_ARG" ]] || {
        echo "Environment file not found: $ENV_ARG" >&2
        exit 1
    }
    ENV_FILE="$(cd "$(dirname "$ENV_ARG")" && pwd)/$(basename "$ENV_ARG")"
fi

[[ -f "$ENV_FILE" ]] || {
    echo "Environment file not found: $ENV_FILE" >&2
    exit 1
}

ENV_KEY="${ENV_BASE#.env.}"

# ------------------------------------------------------------
# Read APP_PORT from the selected environment file
# ------------------------------------------------------------

get_env() {
    sed -n "s/^$1=//p" "$ENV_FILE" |
        tail -n 1 |
        tr -d '\r' |
        sed -e 's/^"//' -e 's/"$//' \
            -e "s/^'//" -e "s/'$//"
}

APP_PORT="$(get_env APP_PORT)"
APP_PORT="${APP_PORT:-8081}"

if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] ||
   (( APP_PORT < 1 || APP_PORT > 65535 )); then
    echo "Invalid APP_PORT in $ENV_FILE" >&2
    exit 1
fi

# ------------------------------------------------------------
# Root / sudo helper
# ------------------------------------------------------------

command -v sudo >/dev/null 2>&1 || {
    [[ "$EUID" -eq 0 ]] || {
        echo "Run as root or install sudo." >&2
        exit 1
    }
}

run_root() {
    if [[ "$EUID" -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

command -v curl >/dev/null 2>&1 || {
    echo "curl is required. Install with: sudo apt-get install -y curl" >&2
    exit 1
}

command -v systemctl >/dev/null 2>&1 || {
    echo "systemd/systemctl is required on this server." >&2
    exit 1
}

# Use the invoking user when run with sudo, so the service
# does not run as root unnecessarily.
RUN_USER="${SUDO_USER:-$(id -un)}"

PASSWD_ENTRY="$(getent passwd "$RUN_USER" || true)"
[[ -n "$PASSWD_ENTRY" ]] || {
    echo "Cannot resolve user: $RUN_USER" >&2
    exit 1
}

RUN_HOME="$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f6)"
RUN_GROUP="$(id -gn "$RUN_USER")"

[[ -n "$RUN_HOME" && -d "$RUN_HOME" ]] || {
    echo "Cannot determine home directory for $RUN_USER" >&2
    exit 1
}

# ------------------------------------------------------------
# Install cloudflared if not installed
# ------------------------------------------------------------

if ! command -v cloudflared >/dev/null 2>&1; then
    [[ -r /etc/os-release ]] || {
        echo "Unsupported OS: expected Ubuntu/Debian." >&2
        exit 1
    }

    . /etc/os-release

    case "${ID:-}:${ID_LIKE:-}" in
        ubuntu:*|debian:*|*:debian*)
            ;;
        *)
            echo "This script supports Ubuntu/Debian only." >&2
            exit 1
            ;;
    esac

    arch="$(dpkg --print-architecture)"

    case "$arch" in
        amd64) cf_arch="amd64" ;;
        arm64) cf_arch="arm64" ;;
        *)
            echo "Unsupported architecture: $arch" >&2
            exit 1
            ;;
    esac

    tmp_deb="$(mktemp --suffix=.deb)"
    trap 'rm -f "${tmp_deb:-}"' EXIT

    download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}.deb"

    echo "Installing cloudflared..."

    curl -fsSL "$download_url" -o "$tmp_deb"
    run_root apt-get update
    run_root apt-get install -y "$tmp_deb"

    rm -f "$tmp_deb"
    trap - EXIT
fi

CF_BIN="$(command -v cloudflared)"

[[ -x "$CF_BIN" ]] || {
    echo "cloudflared executable not found." >&2
    exit 1
}

echo "cloudflared: $CF_BIN"

# ------------------------------------------------------------
# Check that Housiy is responding before initial setup
# ------------------------------------------------------------

if ! curl -fsS --max-time 5 \
    "http://127.0.0.1:${APP_PORT}/" >/dev/null; then

    echo "Housiy is not responding at http://127.0.0.1:${APP_PORT}/." >&2
    echo "Start the application first using:" >&2
    echo "  $ROOT/aws/install-docker-compose-run.sh $ENV_BASE" >&2
    exit 1
fi

# ------------------------------------------------------------
# State files and systemd service
# ------------------------------------------------------------

STATE_DIR="$RUN_HOME/.local/state/housiy"

PID_FILE="$STATE_DIR/cloudflared-${ENV_KEY}.pid"
LOG_FILE="$STATE_DIR/cloudflared-${ENV_KEY}.log"
URL_FILE="$STATE_DIR/cloudflared-${ENV_KEY}.url"

SERVICE_NAME="housiy-cloudflared-${ENV_KEY}.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"

mkdir -p "$STATE_DIR"
chown "$RUN_USER:$RUN_GROUP" "$STATE_DIR"
chmod 700 "$STATE_DIR"

touch "$LOG_FILE"
chown "$RUN_USER:$RUN_GROUP" "$LOG_FILE"
chmod 600 "$LOG_FILE"

# ------------------------------------------------------------
# Create systemd unit
# ------------------------------------------------------------

echo "Configuring systemd service: $SERVICE_NAME"

run_root tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Housiy Cloudflare Quick Tunnel (${ENV_KEY})
Wants=network-online.target
After=network-online.target docker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
Environment=HOME=${RUN_HOME}
WorkingDirectory=${RUN_HOME}

ExecStart=${CF_BIN} tunnel --no-autoupdate --url http://127.0.0.1:${APP_PORT}

Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
EOF

# ------------------------------------------------------------
# Enable boot startup and start/restart the tunnel
# ------------------------------------------------------------

run_root systemctl daemon-reload
run_root systemctl enable "$SERVICE_NAME"

# Clear the previous URL before restarting so an old Quick
# Tunnel URL is not mistaken for the URL of the new process.
run_root systemctl stop "$SERVICE_NAME" 2>/dev/null || true

: > "$LOG_FILE"
rm -f "$URL_FILE" "$PID_FILE"

run_root systemctl start "$SERVICE_NAME"

# ------------------------------------------------------------
# Wait for a new public URL
# ------------------------------------------------------------

echo "Waiting for Cloudflare Quick Tunnel URL..."

public_url=""

for _ in $(seq 1 60); do
    if ! run_root systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "Cloudflare service is not active." >&2
        break
    fi

    public_url="$(
        grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
            "$LOG_FILE" 2>/dev/null |
            tail -n 1 || true
    )"

    if [[ -n "$public_url" ]]; then
        break
    fi

    sleep 1
done

if [[ -z "$public_url" ]]; then
    echo "Cloudflare tunnel did not return a URL within 60 seconds." >&2

    run_root systemctl status "$SERVICE_NAME" --no-pager >&2 || true

    echo "Recent logs:" >&2
    tail -40 "$LOG_FILE" >&2 || true

    exit 1
fi

# ------------------------------------------------------------
# Persist URL and service PID
# ------------------------------------------------------------

printf '%s\n' "$public_url" > "$URL_FILE"

service_pid="$(
    run_root systemctl show "$SERVICE_NAME" \
        --property=MainPID --value
)"

printf '%s\n' "$service_pid" > "$PID_FILE"

chown "$RUN_USER:$RUN_GROUP" "$URL_FILE" "$PID_FILE"
chmod 600 "$URL_FILE" "$PID_FILE"

# ------------------------------------------------------------
# Print results
# ------------------------------------------------------------

printf '\n'
printf '%s\n' "=============================================="
printf '%s\n' " Housiy Cloudflare Tunnel is running"
printf '%s\n' "=============================================="
printf 'Public URL     : %s\n' "$public_url"
printf 'Environment    : %s\n' "$ENV_KEY"
printf 'Local app      : http://127.0.0.1:%s\n' "$APP_PORT"
printf 'Service        : %s\n' "$SERVICE_NAME"
printf 'Service status : '
run_root systemctl is-active "$SERVICE_NAME"
printf 'Boot startup   : '
run_root systemctl is-enabled "$SERVICE_NAME"
printf 'Process ID     : %s\n' "$service_pid"
printf 'Saved URL      : %s\n' "$URL_FILE"
printf 'Log file       : %s\n' "$LOG_FILE"
printf '\n'
printf 'Useful commands:\n'
printf '  Status : sudo systemctl status %s\n' "$SERVICE_NAME"
printf '  Logs   : sudo journalctl -u %s -f\n' "$SERVICE_NAME"
printf '  Stop   : sudo systemctl stop %s\n' "$SERVICE_NAME"
printf '  Start  : sudo systemctl start %s\n' "$SERVICE_NAME"
printf '  Restart: sudo systemctl restart %s\n' "$SERVICE_NAME"
printf '\n'
printf '%s\n' "The tunnel is running in the background."
printf '%s\n' "Automatic restart after reboot is enabled."
printf '%s\n' "=============================================="
