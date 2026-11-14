# Housiy CI/CD – GitHub Actions, GitLab CI and Jenkins

This guide describes three independent CI/CD implementations. Choose one orchestrator per deployment to avoid duplicate deployments. The application source, Dockerfiles, PHP/Node tests and runtime behavior remain unchanged by these pipeline files.

## Pipeline boundaries

| Workflow | What it does | Publishes images? | Changes a cluster? |
|---|---|---:|---:|
| Build + Test | PHP, frontend, realtime tests; build both images | No | No |
| Build + Test + Push | Same tests, optional SonarQube scan, build and push both images to Nexus | Yes | No |
| Deploy existing tag | Pulls a previously published immutable tag and Helm-deploys it | No | Yes |

Never deploy `latest` in production. Use an immutable commit SHA or release tag. Build and push `housiy-app` and `housiy-realtime` with the same tag.

## 1. SonarQube

SonarQube is a separate service and is not bundled into the Housiy application stack.

### Start SonarQube with persistent PostgreSQL

On an Ubuntu/Debian Docker host:

```bash
sudo sysctl -w vm.max_map_count=524288
echo 'vm.max_map_count=524288' | sudo tee /etc/sysctl.d/99-sonarqube.conf
sudo sysctl --system

cd deployment/sonarqube
export SONAR_DB_PASSWORD='use-a-long-unique-secret'
docker compose up -d
docker compose ps
docker compose logs -f sonarqube
```

Open `http://SONAR_HOST:8052`, complete the first-login password change, create project key `housiy-platform`, and generate a project analysis token. Store that token only in your CI secret store as `SONAR_TOKEN`. Do not commit it.

For remote CI agents, `SONAR_HOST_URL` must be reachable from the runner/agent (for example `https://sonarqube.example.com`). The included `sonar-project.properties` is the source of project key, source/test paths and exclusions. Configure a SonarQube Quality Gate and make the pipeline wait/fail on that gate if your SonarQube edition and scanner integration support it. A scan upload alone is not a Quality Gate pass.

SonarQube server data and PostgreSQL data are held in named volumes. Back them up before upgrades. Upgrade the SonarQube image deliberately; do not use `docker compose down -v`.

## 2. GitHub Actions

Workflows are in `.github/workflows/`:

- `01-build-test.yml` runs automatically for pushes/PRs to `dev`, `stg`, `main`, and can be run manually. It does not push or deploy.
- `02-build-test-push-nexus.yml` is manually dispatched. It tests, optionally scans, builds and pushes both images.
- `03-deploy-helm.yml` is manually dispatched and deploys an existing Nexus tag. It does not rebuild images.

### GitHub repository configuration

Repository **Variables**:
- `NEXUS_REGISTRY`: registry host including port, without `https://` or repository path, e.g. `nexus.example.com:8051`
- `NEXUS_NAMESPACE`: Docker repository namespace/path, e.g. `housiy`
- `SONAR_HOST_URL`: reachable SonarQube base URL
- `AWS_REGION`, `EKS_CLUSTER_NAME`: for EKS deployment

Repository **Secrets**:
- `NEXUS_USER`, `NEXUS_PASSWORD`
- `SONAR_TOKEN`
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `REDIS_PASSWORD`
- `KUBECONFIG_B64` for non-AWS Kubernetes, OR `AWS_DEPLOY_ROLE_ARN` for EKS.

For AWS, configure GitHub OIDC trust on the IAM role. Restrict the role trust policy to the exact GitHub organization/repository and deployment branch/environment; do not use long-lived AWS access keys. The role needs EKS describe/connect permissions and Kubernetes RBAC authorization in the target cluster. The workflow's EKS role path is selected by `aws_eks=true`.

### Run separately

1. Run **Housiy - Build and Test** to validate a commit.
2. Run **Housiy - Build Test and Push to Nexus**, choose a unique tag such as the full commit SHA.
3. Verify both tags exist in Nexus.
4. Run **Housiy - Deploy Published Images**, select `staging` or `production`, supply exactly the pushed tag and select EKS or kubeconfig mode.

Set GitHub Environment protection/reviewers for `production`. The deploy workflow creates a Kubernetes image-pull secret from Nexus credentials and runs `helm upgrade --install --wait`.

## 3. GitLab CI

The root `.gitlab-ci.yml` defines validate/test/quality/build/push/deploy stages. Configure these GitLab CI/CD variables (mask/protect secrets):

- `SONAR_HOST_URL`, `SONAR_TOKEN`
- `NEXUS_REGISTRY`, `NEXUS_NAMESPACE`, `NEXUS_USER`, `NEXUS_PASSWORD`
- `KUBECONFIG_B64`
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `REDIS_PASSWORD`

The GitLab Docker runner must support Docker-in-Docker (`privileged=true`) for image builds. For a hardened environment, use a dedicated isolated runner and short-lived registry credentials. Push and deploy jobs are manual gates. Deploy targets `housiy-staging` for `stg` and `housiy-production` for `main`; both require the target DB and network to be reachable from the cluster.

The pipeline uses the commit SHA as the immutable image tag. It never pushes `latest`.

## 4. Jenkins

The existing root `Jenkinsfile` is the Jenkins implementation and already contains Checkout, PHP/Playwright dependencies, PHPUnit, UI tests, k6 smoke tests, SonarQube analysis/Quality Gate, Trivy, Nexus push and Kubernetes deploy stages.

Create a **Multibranch Pipeline** job so `BRANCH_NAME` is populated. Review the Jenkinsfile header and `docs/ci-cd/jenkins.md` for its exact credential IDs and tool prerequisites. In particular configure:
- Nexus Docker registry credential `housiy-nexus-registry`
- SonarQube token credential `housiy-sonar-token` and a Jenkins SonarQube server named `SonarQube`
- kubeconfig credentials for staging and production
- Docker, Compose, PHP 8.3, Composer, Node/npm, k6, Trivy, SonarScanner and kubectl on the agent.

The current Jenkinsfile has branch-specific behavior (`dev`, `stg`, `main`) and should be reviewed before production use. Its stg path contains a local-cluster assumption; use the Nexus image path for a remote Kubernetes cluster. Do not assume a green build proves the cluster's database, ingress, storage or DNS are configured.

## 5. Nexus repository setup

Create a **Docker hosted** repository in Nexus (not a proxy/group repository) and configure its connector port. Configure the registry endpoint as `host:port`. The registry namespace/path is configured separately in CI. Ensure:
- CI account has push/pull permissions.
- Kubernetes has pull credentials (`nexus-pull`).
- Nodes can resolve and reach Nexus and trust its TLS certificate.
- Nexus retention/cleanup preserves currently deployed release tags.
- Immutable tags are used; do not overwrite an existing release tag.

If Nexus is behind a reverse proxy, configure Docker registry token/auth endpoints and the connector port consistently. Test `docker login`, `docker push`, and a pull from a Kubernetes node before enabling deploy.

## 6. Test and release gates

Required baseline before pushing:
- `composer validate --no-check-publish`
- `composer install --no-interaction --prefer-dist`
- `vendor/bin/phpunit`
- `npm ci && npm test` in `tests/frontend`
- `npm ci && npm test` in `realtime`
- `docker build` for both application and realtime gateway

The PHP Dockerfile contains the PHP-FPM application. The realtime image is built from `realtime/`. Do not accidentally push only one of these images.

The workflows do not run destructive schema migrations automatically. Review and apply SQL changes using a controlled backup/migration process before release.


### Host re-entry and admin block behavior

The public room-code join endpoint resolves the authenticated account against `rooms.host_user_id`. If the account owns the room, it returns `role=HOST` / `is_host=true` and the landing page opens `host.html`; it does not downgrade the owner to a player. This also supports reopening a LIVE or COMPLETED hosted room and repairs a missing host membership/ticket defensively. Admin identity blocks are still enforced by `Auth::identify` before any room join: a blocked host cannot re-enter or obtain host controls until an administrator unblocks the identity. Once unblocked, the host can authenticate again, re-enter by room code, and recover the host console and hosted-game history.

### Database setup

`sql/schema.sql` is the consolidated schema for new installations. For an existing database, compare its table definitions with this schema and apply a reviewed, backed-up migration for any missing columns; no standalone migration SQL is included in this release.
