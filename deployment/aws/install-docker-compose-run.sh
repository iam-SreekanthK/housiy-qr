
#!/usr/bin/env bash
# Housiy: idempotent Docker Compose deployment for Ubuntu/Debian.
#
# Expected structure:
#   housiy/
#   └── deployment/
#       ├── aws/
#       │   └── install-docker-compose-run.sh
#       └── docker/
#           ├── docker-compose.yml
#           ├── .env.dev
#           ├── .env.uat
#           └── .env.prod
#
# Usage:
#   bash deployment/aws/install-docker-compose-run.sh .env.dev
#   bash deployment/aws/install-docker-compose-run.sh .env.uat
#   bash deployment/aws/install-docker-compose-run.sh .env.prod
#   bash deployment/aws/install-docker-compose-run.sh .env.dev --no-build
#
# Cloudflare is managed separately.

set -Eeuo pipefail
umask 077

# ------------------------------------------------------------
# 1. Resolve project paths from this script's location.
# ------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$DEPLOYMENT_DIR/.." && pwd)"
DOCKER_DIR="$DEPLOYMENT_DIR/docker"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"

# ------------------------------------------------------------
# 2. Parse arguments.
# ------------------------------------------------------------

usage() {
    echo "Usage: $0 .env.dev|.env.uat|.env.prod [--no-build]"
}

[[ $# -ge 1 ]] || {
    usage >&2
    exit 2
}

ENV_ARG="$1"
shift
NO_BUILD=0

for arg in "$@"; do
    case "$arg" in
        --no-build) NO_BUILD=1 ;;
        *)
            usage >&2
            exit 2
            ;;
    esac
done

ENV_BASE="$(basename "$ENV_ARG")"

case "$ENV_BASE" in
    .env.dev) ENV_NAME=dev ;;
    .env.uat) ENV_NAME=uat ;;
    .env.prod) ENV_NAME=prod ;;
    *)
        usage >&2
        echo "Unsupported environment: $ENV_BASE" >&2
        exit 2
        ;;
esac

# Bare filenames always resolve inside deployment/docker.
# Explicit paths can refer to an existing environment file elsewhere.
if [[ "$ENV_ARG" == */* ]]; then
    [[ -f "$ENV_ARG" ]] || {
        echo "Environment file not found: $ENV_ARG" >&2
        exit 1
    }
    ENV_FILE="$(cd "$(dirname "$ENV_ARG")" && pwd)/$(basename "$ENV_ARG")"
else
    ENV_FILE="$DOCKER_DIR/$ENV_BASE"
fi

[[ -f "$ENV_FILE" ]] || {
    echo "Environment file not found: $ENV_FILE" >&2
    echo "Create it before deploying; this script will not invent secrets." >&2
    exit 1
}

[[ -f "$COMPOSE_FILE" ]] || {
    echo "Compose file not found: $COMPOSE_FILE" >&2
    exit 1
}

echo "=============================================="
echo " Housiy deployment"
echo "=============================================="
echo "Project root : $ROOT"
echo "Script dir   : $SCRIPT_DIR"
echo "Compose file : $COMPOSE_FILE"
echo "Environment  : $ENV_NAME"
echo "Env file     : $ENV_FILE"
echo "Build images : $((1 - NO_BUILD))"
echo "=============================================="

# ------------------------------------------------------------
# 3. Root privilege helper.
# ------------------------------------------------------------

if [[ "$EUID" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo "Run as root or install sudo." >&2
    exit 1
fi

run_root() {
    if [[ "$EUID" -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

# ------------------------------------------------------------
# 4. Install prerequisite utilities only if missing.
# ------------------------------------------------------------

if ! command -v curl >/dev/null 2>&1 ||
   ! command -v ca-certificates >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y curl ca-certificates
fi

command -v systemctl >/dev/null 2>&1 || {
    echo "systemctl is required for Docker service management." >&2
    exit 1
}

# ------------------------------------------------------------
# 5. Install Docker Engine and Compose v2 if missing.
# ------------------------------------------------------------

if command -v docker >/dev/null 2>&1 &&
   docker compose version >/dev/null 2>&1; then

    echo "[SKIP] Docker Engine and Compose v2 are installed."

else
    [[ -r /etc/os-release ]] || {
        echo "Cannot identify the operating system." >&2
        exit 1
    }

    . /etc/os-release

    case "${ID:-}:${ID_LIKE:-}" in
        ubuntu:*|debian:*|*:debian*) ;;
        *)
            echo "Docker installation supports Ubuntu/Debian only." >&2
            exit 1
            ;;
    esac

    ARCH="$(dpkg --print-architecture)"
    CODENAME="${VERSION_CODENAME:-}"

    [[ -n "$CODENAME" ]] || {
        echo "Cannot determine OS release codename." >&2
        exit 1
    }

    KEYRING="/etc/apt/keyrings/docker.asc"
    REPO_FILE="/etc/apt/sources.list.d/docker.list"

    run_root install -m 0755 -d /etc/apt/keyrings

    if [[ ! -s "$KEYRING" ]]; then
        echo "Installing Docker repository key..."
        tmp_key="$(mktemp)"
        trap 'rm -f "${tmp_key:-}"' EXIT

        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
            -o "$tmp_key"

        run_root install -m 0644 "$tmp_key" "$KEYRING"
        rm -f "$tmp_key"
        trap - EXIT
    else
        echo "[SKIP] Docker repository key exists."
    fi

    REPO_LINE="deb [arch=${ARCH} signed-by=${KEYRING}] https://download.docker.com/linux/${ID} ${CODENAME} stable"

    if [[ "$(cat "$REPO_FILE" 2>/dev/null || true)" != "$REPO_LINE" ]]; then
        printf '%s\n' "$REPO_LINE" |
            run_root tee "$REPO_FILE" >/dev/null
    else
        echo "[SKIP] Docker repository is configured."
    fi

    run_root apt-get update
    run_root apt-get install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    docker compose version >/dev/null
    echo "[OK] Docker Engine and Compose v2 installed."
fi

# ------------------------------------------------------------
# 6. Ensure Docker starts now and after a reboot.
# ------------------------------------------------------------

if run_root systemctl is-active --quiet docker &&
   run_root systemctl is-enabled --quiet docker; then
    echo "[SKIP] Docker is running and enabled at boot."
else
    echo "Enabling and starting Docker..."
    run_root systemctl enable --now docker
fi

# ------------------------------------------------------------
# 7. Choose Docker command without assuming the user's home.
# ------------------------------------------------------------

if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
elif [[ "$EUID" -eq 0 ]]; then
    echo "Docker daemon is not accessible, even as root." >&2
    exit 1
else
    echo "Checking Docker access with sudo..."
    if sudo docker info >/dev/null 2>&1; then
        DOCKER_CMD=(sudo docker)
    else
        echo "Docker daemon is unavailable." >&2
        echo "Check: sudo systemctl status docker" >&2
        echo "If group membership was just changed, log in again." >&2
        exit 1
    fi
fi

DC=(
    "${DOCKER_CMD[@]}" compose
    --project-name "housiy-$ENV_NAME"
    --env-file "$ENV_FILE"
    -f "$COMPOSE_FILE"
)

# ------------------------------------------------------------
# 8. Read environment values without printing secrets.
# ------------------------------------------------------------

value() {
    sed -n "s/^$1=//p" "$ENV_FILE" |
        tail -n 1 |
        tr -d '\r' |
        sed -e 's/^"//' -e 's/"$//' \
            -e "s/^'//" -e "s/'$//"
}

# ------------------------------------------------------------
# 9. Validate required configuration.
# ------------------------------------------------------------

echo "Validating environment configuration..."

for key in \
    APP_ENV \
    APP_PORT \
    DB_EXPOSED_PORT \
    MYSQL_ROOT_PASSWORD \
    MYSQL_DATABASE \
    MYSQL_APP_USER \
    MYSQL_APP_PASSWORD \
    REDIS_PREFIX; do

    [[ -n "$(value "$key")" ]] || {
        echo "Missing required $key in $ENV_FILE" >&2
        exit 1
    }
done

APP_ENV_VALUE="$(value APP_ENV | tr '[:upper:]' '[:lower:]')"

case "$ENV_NAME:$APP_ENV_VALUE" in
    dev:dev|dev:development|uat:uat|uat:staging|prod:prod|prod:production)
        ;;
    *)
        echo "APP_ENV does not match selected environment." >&2
        exit 1
        ;;
esac

APP_PORT="$(value APP_PORT)"
DB_PORT="$(value DB_EXPOSED_PORT)"

for item in "APP_PORT:$APP_PORT" "DB_EXPOSED_PORT:$DB_PORT"; do
    key="${item%%:*}"
    port="${item#*:}"

    if ! [[ "$port" =~ ^[0-9]+$ ]] ||
       (( port < 1 || port > 65535 )); then
        echo "Invalid $key in $ENV_FILE" >&2
        exit 1
    fi
done

# ------------------------------------------------------------
# 10. Enforce production security settings on every run.
# ------------------------------------------------------------

if [[ "$ENV_NAME" == prod ]]; then
    echo "Checking production security configuration..."

    if [[ "$(value RATE_LIMIT_ENABLED)" != 1 ]]; then
        echo "Enforcing RATE_LIMIT_ENABLED=1..."

        if grep -q '^RATE_LIMIT_ENABLED=' "$ENV_FILE"; then
            sed -i 's/^RATE_LIMIT_ENABLED=.*/RATE_LIMIT_ENABLED=1/' "$ENV_FILE"
        else
            printf '\nRATE_LIMIT_ENABLED=1\n' >> "$ENV_FILE"
        fi
    else
        echo "[SKIP] Production rate limiting is enabled."
    fi

    [[ -n "$(value REDIS_PASSWORD)" ]] || {
        echo "REDIS_PASSWORD is required in production." >&2
        exit 1
    }

    [[ -n "$(value RATE_LIMIT_HASH_SALT)" ]] || {
        echo "RATE_LIMIT_HASH_SALT is required in production." >&2
        exit 1
    }

    [[ "$(value COOKIE_SECURE)" == 1 ]] || {
        echo "COOKIE_SECURE=1 is required in production." >&2
        exit 1
    }

    echo "[OK] Production security checks passed."
fi

# ------------------------------------------------------------
# 11. Warn about the recommended port assignments.
# ------------------------------------------------------------

case "$ENV_NAME:$APP_PORT:$DB_PORT" in
    dev:8081:3307|uat:8082:3308|prod:80:3309)
        echo "[OK] Expected host port assignments are configured."
        ;;
    *)
        echo "[INFO] Custom ports: APP_PORT=$APP_PORT, DB_EXPOSED_PORT=$DB_PORT"
        echo "Ensure they do not conflict with other applications."
        ;;
esac

# ------------------------------------------------------------
# 12. Validate Compose configuration before changing containers.
# ------------------------------------------------------------

echo "Validating Docker Compose configuration..."
"${DC[@]}" config -q
echo "[OK] Compose configuration is valid."

# ------------------------------------------------------------
# 13. Build and deploy.
# ------------------------------------------------------------

if [[ "$NO_BUILD" -eq 0 ]]; then
    echo "Building images using Docker's build cache..."
    "${DC[@]}" build
else
    echo "[SKIP] Image build requested to be skipped."
fi

echo "Creating/updating containers..."
"${DC[@]}" up -d

# ------------------------------------------------------------
# 14. Display deployment status.
# ------------------------------------------------------------

echo
echo "Container status:"
"${DC[@]}" ps

# ------------------------------------------------------------
# 15. Check application readiness.
# ------------------------------------------------------------

APP_URL="http://127.0.0.1:${APP_PORT}/"

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required for the readiness check." >&2
    exit 1
fi

echo
echo "Waiting for Housiy to respond at $APP_URL ..."

HEALTHY=0

for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 "$APP_URL" >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 2
done

if [[ "$HEALTHY" -ne 1 ]]; then
    echo "ERROR: Housiy did not respond within 120 seconds." >&2
    echo "Container status:" >&2
    "${DC[@]}" ps >&2 || true
    echo "Recent container logs:" >&2
    "${DC[@]}" logs --tail=100 >&2 || true
    exit 1
fi

# ------------------------------------------------------------
# 16. Final summary.
# ------------------------------------------------------------

echo
echo "=============================================="
echo " Housiy deployment completed successfully"
echo "=============================================="
echo "Environment : $ENV_NAME"
echo "Project     : housiy-$ENV_NAME"
echo "Local URL   : $APP_URL"
echo "Env file    : $ENV_FILE"
echo
echo "Useful commands:"
echo "  Status:"
printf '    '
printf '%q ' "${DC[@]}"
echo "ps"
echo "  Logs:"
printf '    '
printf '%q ' "${DC[@]}"
echo "logs -f"
echo "  Stop:"
printf '    '
printf '%q ' "${DC[@]}"
echo "stop"
echo "  Restart:"
printf '    '
printf '%q ' "${DC[@]}"
echo "restart"
echo
echo "Docker is configured to start at system boot."
echo "Cloudflare is managed separately."
echo "=============================================="
