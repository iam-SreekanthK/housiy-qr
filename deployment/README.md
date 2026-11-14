# Deployment entry points

Choose the deployment method that matches your environment:

- `docker/` — existing Docker Compose deployment for a single VM.
- `k8s/` — existing plain Kubernetes manifests and realtime manifests.
- `helm/housiy/` — Helm chart for Kubernetes and AWS EKS.
- `sonarqube/` — standalone SonarQube + PostgreSQL service for code-quality analysis.
- `aws/` — Ubuntu/Docker Compose installation helper.

CI/CD orchestration is at repository root:
- `.github/workflows/` for GitHub Actions.
- `.gitlab-ci.yml` for GitLab.
- `Jenkinsfile` for Jenkins.

See `../docs/ci-cd/README.md` and `../docs/deployment/kubernetes-helm-aws-eks.md` before deploying. Do not run multiple CI systems against the same production namespace at the same time.

### Docker Compose commands from the repository root

The Compose project name is pinned to `housiy` so commands work consistently from the repository root and continue to address the existing Housiy stack. For the DEV environment use:

```bash
docker compose -p housiy --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml ps -a
docker compose -p housiy --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml logs --tail=200 worker
docker compose -p housiy --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml logs -f --tail=100 worker
```

Create `deployment/docker/.env.dev` by copying `.env.example`, then set `APP_ENV=dev`, unique DEV database/Redis values and generated credentials. Keep it private and back it up securely. If this is an existing database volume, changing MySQL passwords in the env file does not change the credentials already stored inside MySQL. Update the MySQL users to match before restarting services, or preserve the previous working credentials. Never run `docker compose down -v` unless you intentionally want to delete database and Redis data.
