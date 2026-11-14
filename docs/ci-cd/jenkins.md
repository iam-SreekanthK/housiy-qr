# Jenkins setup and operation

## Job type

Use a **Multibranch Pipeline** job pointing at this repository. The root `Jenkinsfile` expects `BRANCH_NAME` and has branch behavior for `dev`, `stg`, and `main`. Configure branch discovery and webhook triggers. Do not create concurrent release jobs; the Jenkinsfile disables concurrent builds.

## Credentials

Create credentials with these exact IDs (Manage Jenkins → Credentials):

| ID | Jenkins type | Purpose |
|---|---|---|
| `housiy-nexus-registry` | Username with password | Nexus Docker login and raw artifact upload |
| `housiy-dockerhub-registry` | Username with password | Docker Hub release push on `main` |
| `housiy-sonar-token` | Secret text | SonarQube analysis |
| `housiy-github-token` | Username with password | GitHub release/tag operation |
| `housiy-db-root-password` | Secret text | Isolated test stack |
| `housiy-db-app-password` | Secret text | Isolated test stack |
| `housiy-k8s-stg-kubeconfig` | Secret file | Staging Kubernetes access |
| `housiy-k8s-prod-kubeconfig` | Secret file | Production Kubernetes access |

The Jenkinsfile also declares the Nexus registry endpoint/repository and Docker Hub repository in its environment section. Adjust those constants to your actual registry endpoints; do not place passwords there.

## SonarQube server

1. Start the stack in `deployment/sonarqube`.
2. Open **Manage Jenkins → System → SonarQube servers**.
3. Add a server named exactly `SonarQube`.
4. Set the URL to `http://SONAR_HOST:8052` (or your HTTPS reverse-proxy URL).
5. Select credential `housiy-sonar-token`.
6. Install/configure the SonarQube Scanner tool if the Jenkinsfile/agent uses the Jenkins tool installation. Ensure the agent can reach the server.
7. Configure a Quality Gate in SonarQube. The Jenkins Quality Gate stage waits for the analysis result.

## Agent tools

The Jenkins agent needs Docker Engine + Compose v2, PHP 8.3, Composer, Node/npm, k6, Trivy, SonarScanner, kubectl, Helm where used, curl, zip and Git. Docker daemon access is privileged; use dedicated trusted agents and do not run untrusted pull-request code on a privileged production agent.

## Branch behavior

Read the branch-specific stage comments in the root Jenkinsfile before enabling deploy:
- `dev`: tests/scans, Nexus push and local Compose development deploy.
- `stg`: image build/push, Kubernetes staging deploy and full k6 suite.
- `main`: release tagging/artifacts and production Kubernetes deploy.

The staging path in the existing Jenkinsfile documents a local Docker-engine assumption for one deployment route. For remote EKS, ensure the Nexus image reference and `imagePullPolicy: Always` are used. Verify the generated manifests and kubeconfig context before allowing production.

## Safe first run

Set the Jenkins `DEPLOY` parameter false. Run the dev branch and inspect PHPUnit, frontend, realtime, SonarQube Quality Gate, Trivy and image-push results. Then validate staging with a disposable namespace. Enable production only after a successful staging smoke/load test and an approved change.
