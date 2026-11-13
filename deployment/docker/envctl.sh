#!/usr/bin/env bash
# Housiy environment controller (works in Git Bash on Windows, Linux, macOS).
#
#   bash deployment/docker/envctl.sh <dev|uat|prod> <command> [args]
#
# Commands: validate | config | up | down | restart | status | logs [svc] | health | env [svc]
#
# Every environment is a separate Compose PROJECT (housiy-dev / housiy-uat /
# housiy-prod): own containers, network and named volumes, so `down` on one
# can never touch another, and no command here ever deletes volumes.
set -euo pipefail

ENV_NAME="${1:-}"; CMD="${2:-}"; shift 2 || true
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="$HERE/docker-compose.yml"
ENV_FILE="$HERE/.env.$ENV_NAME"
PROJECT="housiy-$ENV_NAME"

die() { echo "ERROR: $*" >&2; exit 1; }
case "$ENV_NAME" in dev|uat|prod) ;; *) die "usage: envctl.sh <dev|uat|prod> <validate|config|up|down|restart|status|logs|health|env>";; esac
dc() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r'; }

validate() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy $HERE/.env.example to $ENV_FILE and fill it in."
  errs=0
  bad() { echo "  FAIL: $*"; errs=$((errs+1)); }
  echo "Validating $ENV_NAME ($ENV_FILE) - secret values are never printed"
  local appenv; appenv="$(val APP_ENV | tr 'A-Z' 'a-z')"
  case "$ENV_NAME:$appenv" in
    dev:dev|dev:development|uat:uat|uat:staging|prod:prod|prod:production) ;;
    *) bad "APP_ENV='$appenv' does not match environment '$ENV_NAME' (dev|development / uat|staging / prod|production)";;
  esac
  for k in APP_PORT DB_EXPOSED_PORT MYSQL_ROOT_PASSWORD MYSQL_DATABASE MYSQL_APP_USER MYSQL_APP_PASSWORD REDIS_PREFIX; do
    [ -n "$(val $k)" ] || bad "$k is empty"
  done
  grep -qE '^[A-Z_]+=.*CHANGE_ME' "$ENV_FILE" && bad "placeholder CHANGE_ME still present"
  case "$(val MYSQL_DATABASE)" in *"$ENV_NAME"*) ;; *) bad "MYSQL_DATABASE should contain '$ENV_NAME' (separate database per environment)";; esac
  case "$(val REDIS_PREFIX)" in *"$ENV_NAME"*) ;; *) bad "REDIS_PREFIX should contain '$ENV_NAME'";; esac
  # No two environments may share a published port, database name, or credentials.
  for other in dev uat prod; do
    [ "$other" = "$ENV_NAME" ] && continue
    local of="$HERE/.env.$other"; [ -f "$of" ] || continue
    for k in APP_PORT DB_EXPOSED_PORT MYSQL_DATABASE MYSQL_APP_USER; do
      [ "$(val $k)" = "$(grep -E "^$k=" "$of" | tail -1 | cut -d= -f2- | tr -d '\r')" ] && bad "$k is identical to $other's"
    done
    for k in MYSQL_ROOT_PASSWORD MYSQL_APP_PASSWORD REDIS_PASSWORD; do
      [ -n "$(val $k)" ] && [ "$(val $k)" = "$(grep -E "^$k=" "$of" | tail -1 | cut -d= -f2- | tr -d '\r')" ] && bad "$k is reused from $other (credentials must differ per environment)"
    done
  done
  if [ "$ENV_NAME" != dev ]; then
    [ -n "$(val REDIS_PASSWORD)" ] || bad "REDIS_PASSWORD is required for $ENV_NAME"
    [ "$(val RATE_LIMIT_ENABLED)" = "0" ] && bad "RATE_LIMIT_ENABLED=0 is not allowed outside dev (the app ignores it, but do not set it)"
    [ -n "$(val RATE_LIMIT_HASH_SALT)" ] || bad "RATE_LIMIT_HASH_SALT should be set (random value)"
  fi
  if [ "$ENV_NAME" = prod ]; then
    local tp; tp="$(val TRUSTED_PROXIES)"
    [ -n "$tp" ] || echo "  WARN: TRUSTED_PROXIES empty - every client behind your proxy will share the proxy's IP for per-IP limits"
    case "$tp" in *0.0.0.0/0*|*::/0*|*172.16.0.0/12*|*10.0.0.0/8*|*192.168.0.0/16*) bad "TRUSTED_PROXIES too broad for prod ('$tp'): list the exact proxy/ingress address or a narrow CIDR";; esac
    [ "$(val COOKIE_SECURE)" = "0" ] && bad "COOKIE_SECURE=0 is not allowed in prod"
    case "$(val APP_PORT)" in 8081|8082) bad "prod APP_PORT looks like a dev/uat port";; esac
  fi
  if command -v docker >/dev/null 2>&1; then
    dc config -q 2>/tmp/envctl.cfg.err || { bad "docker compose config failed: $(head -c 300 /tmp/envctl.cfg.err)"; }
  else
    echo "  NOTE: docker not found - skipped 'docker compose config'"
  fi
  [ "$errs" -eq 0 ] && echo "OK: $ENV_NAME configuration is valid" || { echo "$errs problem(s)"; return 1; }
}

case "$CMD" in
  validate) validate;;
  config)   validate >/dev/null; dc config | sed -E 's/((PASSWORD|PASS|SALT)[A-Z_]*:) .*/\1 <redacted>/';;
  up)
    validate
    if [ "$ENV_NAME" = prod ] && [ "${CONFIRM_PROD:-}" != "yes" ]; then
      die "prod deployment needs explicit authorisation: re-run with CONFIRM_PROD=yes. This rebuilds the image and recreates containers (brief downtime); volumes are kept."
    fi
    dc up -d --build "$@";;
  down)     dc down --remove-orphans "$@";;   # never -v: volumes (database) are kept
  restart)  dc restart "$@";;
  status)   dc ps;;
  logs)     dc logs --tail=200 "$@";;
  health)
    echo "== container health ($PROJECT) =="; dc ps --format 'table {{.Service}}\t{{.Status}}'
    echo "== worker / persistence =="; dc exec -T worker php /var/www/bin/status.php --json | head -40
    echo "== effective environment as seen by the app container (secrets masked) =="
    dc exec -T php sh -c 'env | grep -E "^(APP_ENV|DB_NAME|REDIS_PREFIX|TRUSTED_PROXIES|RATE_LIMIT_ENABLED|COOKIE_SECURE)=" | sort';;
  env)      dc exec -T "${1:-php}" sh -c 'env | grep -E "^(APP_ENV|DB_NAME|REDIS_PREFIX|TRUSTED_PROXIES|RATE_LIMIT_ENABLED|RATE_LIMIT_OVERRIDES|COOKIE_SECURE|REDIS_HOST)=" | sort';;
  *) die "unknown command '$CMD'";;
esac
