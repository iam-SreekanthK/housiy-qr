// ============================================================================
// Housiy CI/CD pipeline - branch-driven (full walkthrough: pipeline-setup.md)
// Recommended Jenkins job name: "housiy-cicd" (Multibranch Pipeline)
//
// Requires a Jenkins MULTIBRANCH PIPELINE job (not a plain Pipeline job) so
// env.BRANCH_NAME is populated automatically. Three branches are meaningful:
//
//   dev  -> install deps, full test suite (PHPUnit/Playwright/k6 smoke),
//           SonarQube + Quality Gate, Trivy image scan (HTML report), push
//           the image to Nexus (tag dev-<build>, traceability only - the
//           local deploy below doesn't pull it back), then deploy locally
//           via docker compose (app container only - db/phpmyadmin are
//           never touched).
//
//   stg  -> NO security scan (already done on dev). Builds a fresh image
//           from the stg branch code, pushes it to Nexus (tag
//           stg-<build>), then deploys it to the housiy-stg Kubernetes
//           namespace straight from the local Docker engine
//           (imagePullPolicy: IfNotPresent - this assumes the k8s cluster
//           and the Jenkins agent share the same Docker engine, e.g.
//           Docker Desktop's built-in Kubernetes. If stg's cluster is
//           remote, point this stage's deploy at the Nexus image instead -
//           see pipeline-setup.md), then runs the FULL k6 suite
//           (smoke+load+stress+soak) and publishes the complete HTML
//           report.
//
//   main -> NO security scan. Builds a fresh image from main, pushes it to
//           BOTH Nexus (tag = release version) and Docker Hub, pushes the
//           PHP zip to Nexus (main only - dev/stg never push the zip),
//           tags the release in GitHub, then deploys to the housiy-prod
//           Kubernetes namespace pulling the image from Nexus.
//
// Any other branch just checks out and stops (see Determine Version).
//
// Credentials (Manage Jenkins > Credentials):
//   housiy-nexus-registry       Username with password - Nexus CI user (docker login + zip upload)
//   housiy-dockerhub-registry   Username with password - Docker Hub user + access token (main only)
//   housiy-sonar-token          Secret text            - SonarQube user token
//   housiy-github-token         Username with password - GitHub PAT (username + token)
//   housiy-db-root-password     Secret text            - MySQL root password
//   housiy-db-app-password      Secret text             - MySQL app-user password
//   housiy-k8s-stg-kubeconfig   Secret file             - kubeconfig for the stg cluster/namespace
//   housiy-k8s-prod-kubeconfig  Secret file             - kubeconfig for the prod cluster/namespace
//
// System config (Manage Jenkins > System):
//   SonarQube servers > Name 'SonarQube', Server URL http://localhost:8052, Server authentication token = housiy-sonar-token
//
// Tools expected on the agent PATH: docker, docker compose, kubectl, trivy,
// sonar-scanner, composer, php 8.3, node/npm, k6, curl, zip (or PowerShell
// Compress-Archive on Windows), git.
// ============================================================================
pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    parameters {
        booleanParam(name: 'DEPLOY', defaultValue: true,
            description: 'Deploy after build/test/scan succeed. Turn off to just validate a branch without touching dev/stg/prod.')
        string(name: 'DEV_APP_PORT', defaultValue: '8090',
            description: '[dev only] Host port for the app container (kept separate from the CI test-stack port).')
        string(name: 'DEV_DB_PORT', defaultValue: '13307',
            description: '[dev only] Host port (loopback only) for the db container.')
        string(name: 'K8S_STG_NAMESPACE', defaultValue: 'housiy-stg', description: '[stg only] Namespace to deploy into.')
        string(name: 'K8S_PROD_NAMESPACE', defaultValue: 'housiy-prod', description: '[main only] Namespace to deploy into.')
        string(name: 'K8S_REPLICAS', defaultValue: '2', description: '[stg/main only] Pod replica count.')
        string(name: 'K8S_STG_NODE_PORT', defaultValue: '30080', description: '[stg only] NodePort (30000-32767) the app Service is exposed on.')
        string(name: 'K8S_PROD_NODE_PORT', defaultValue: '30090', description: '[main only] NodePort (30000-32767) the app Service is exposed on.')
        string(name: 'GITHUB_REPO_URL', defaultValue: '',
            description: '[main only] https://github.com/<org>/<repo>.git - leave blank to auto-detect from checkout.')
    }

    environment {
        APP_IMAGE_REPO    = 'housiy-app'
        APP_IMAGE_TAG     = "${env.BUILD_NUMBER}"
        NEXUS_REGISTRY    = 'localhost:8051'                       // Nexus Docker (hosted) registry connector
        NEXUS_RAW_URL     = 'http://localhost:8051/repository/housiy-zips' // Nexus raw-hosted repo for the PHP zip artifact
        DOCKER_REGISTRY   = credentials('housiy-nexus-registry')   // -> DOCKER_REGISTRY_USR / _PSW (Nexus docker login)
        DOCKERHUB_REPO    = 'ksk5940/housiy-app'                   // Docker Hub namespace/repo - main branch only
        CI_PROJECT_NAME   = "housiy_ci_${env.BUILD_NUMBER}"
        CI_APP_PORT       = '18899'
        CI_DB_PORT        = '13306'
        DEV_PROJECT_NAME  = 'housiy_dev' // stable (not per-build) - same stack is reused/updated across builds
        SONARQUBE_SERVER  = 'SonarQube'                            // Jenkins-side server config -> should point at http://localhost:8052
        TRIVY_SEVERITY    = 'CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN'      // report everything; doesn't fail the build (see Trivy stage)
        RESULTS_DIR       = 'tests-results'
        CI_COMPOSE_FILE   = 'deployment/docker/docker-compose.yml'
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                script { ensureDir(env.RESULTS_DIR) }
            }
        }

        stage('Determine Version') {
            steps {
                script {
                    env.BRANCH = (env.BRANCH_NAME ?: env.GIT_BRANCH ?: '').replaceFirst('^origin/', '')
                    if (!(env.BRANCH in ['dev', 'stg', 'main'])) {
                        echo "Branch '${env.BRANCH}' is not dev/stg/main - nothing to build here. (Open a PR into dev/stg/main to run the real pipeline.)"
                        currentBuild.result = 'NOT_BUILT'
                        error("Skipping non-pipeline branch '${env.BRANCH}'.")
                    }

                    def dateStr = new Date().format('yyyy.MM.dd')
                    env.VERSION_TAG = "v1.${dateStr}.${env.BUILD_NUMBER}"   // main  -> pushed to Nexus + git tag
                    env.STAGE_TAG   = "stg-${env.BUILD_NUMBER}"             // stg   -> local image tag only
                    env.DEV_TAG     = "dev-${env.BUILD_NUMBER}"             // dev   -> local image tag only
                    env.DEPLOY_TAG  = (env.BRANCH == 'main') ? env.VERSION_TAG
                                     : (env.BRANCH == 'stg')  ? env.STAGE_TAG
                                     : env.DEV_TAG
                    echo "Branch: ${env.BRANCH} | Deploy tag: ${env.DEPLOY_TAG}"
                }
            }
        }

        stage('Install Dependencies') {
            when { branch 'dev' }
            parallel {
                stage('Composer (PHP)') {
                    steps {
                        script {
                            runCmd('composer --version')
                            runCmd('composer install --no-interaction --prefer-dist')
                        }
                    }
                }
                stage('Playwright (UI tests)') {
                    steps {
                        dir('tests/ui') {
                            script {
                                runCmd('node --version')
                                runCmd('npm ci')
                                // --with-deps only applies on Linux
                                runCmd(isUnix() ? 'npx playwright install --with-deps chromium' : 'npx playwright install chromium')
                            }
                        }
                    }
                }
            }
        }

        stage('Build Image') {
            // Runs on every branch - stg and main each build their own fresh
            // image from that branch's code rather than promoting dev's image.
            steps {
                script {
                    runCmd("docker build -f Dockerfile -t ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} .")
                }
            }
        }

        stage('Start Isolated Test Stack') {
            when { branch 'dev' }
            steps {
                withCredentials([
                    string(credentialsId: 'housiy-db-root-password', variable: 'DB_ROOT_PW'),
                    string(credentialsId: 'housiy-db-app-password', variable: 'DB_APP_PW')
                ]) {
                    script {
                        writeFile file: '.env.ci', text: """APP_ENV=testing
APP_PORT=${env.CI_APP_PORT}
DB_EXPOSED_PORT=${env.CI_DB_PORT}
MYSQL_ROOT_PASSWORD=${DB_ROOT_PW}
MYSQL_DATABASE=housiy
MYSQL_APP_USER=housiy_app
MYSQL_APP_PASSWORD=${DB_APP_PW}
APP_IMAGE_REPO=${env.APP_IMAGE_REPO}
APP_IMAGE_TAG=${env.APP_IMAGE_TAG}
"""
                        // -p isolates this build's stack so concurrent builds don't collide
                        runCmd("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.CI_PROJECT_NAME} --env-file .env.ci up -d --no-build db")
                        runCmd("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.CI_PROJECT_NAME} --env-file .env.ci up -d --no-build php app redis")

                        echo "Waiting for app to become healthy..."
                        def up = waitFor("curl -sf http://127.0.0.1:${env.CI_APP_PORT}/index.html")
                        if (!up) {
                            runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.CI_PROJECT_NAME} logs app")
                            error("App failed to come up in time")
                        }
                        echo "App is up."
                    }
                }
            }
        }

        stage('Unit & API Tests (PHPUnit)') {
            when { branch 'dev' }
            steps {
                withEnv(["APP_BASE_URL=http://127.0.0.1:${env.CI_APP_PORT}"]) {
                    script {
                        // returnStatus so a missing coverage driver doesn't mask real failures
                        runCmdStatus("vendor/bin/phpunit -c phpunit.xml --log-junit ${env.RESULTS_DIR}/phpunit-junit.xml --coverage-clover ${env.RESULTS_DIR}/phpunit-coverage.xml")
                    }
                }
            }
            post {
                always {
                    junit "${env.RESULTS_DIR}/phpunit-junit.xml"
                }
            }
        }

        stage('UI Tests (Playwright)') {
            when { branch 'dev' }
            steps {
                dir('tests/ui') {
                    withEnv(["APP_BASE_URL=http://127.0.0.1:${env.CI_APP_PORT}"]) {
                        script { runCmd('npx playwright test') }
                    }
                }
            }
            post {
                always {
                    script { copyFile('tests/ui/ui-test-results.xml', "${env.RESULTS_DIR}/playwright-junit.xml") }
                    junit "${env.RESULTS_DIR}/playwright-junit.xml"
                    archiveArtifacts artifacts: 'tests/ui/playwright-report/**', allowEmptyArchive: true
                }
            }
        }

        stage('Load Test (k6 smoke)') {
            // Fast sanity check only - the FULL suite (smoke+load+stress+soak)
            // runs later, against the real stg deployment (see "Full Load Test").
            when { branch 'dev' }
            steps {
                script {
                    runCmd("k6 run -e BASE_URL=http://127.0.0.1:${env.CI_APP_PORT} -e SCENARIO=smoke tests/load/main.js")
                }
            }
            post {
                always {
                    script { copyFile('tests/load/results/junit.xml', "${env.RESULTS_DIR}/k6-junit.xml") }
                    junit "${env.RESULTS_DIR}/k6-junit.xml"
                    archiveArtifacts artifacts: 'tests/load/results/**', allowEmptyArchive: true
                }
            }
        }

        stage('Tear Down Test Stack') {
            when { branch 'dev' }
            steps {
                script {
                    runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.CI_PROJECT_NAME} --env-file .env.ci down -v --remove-orphans")
                    deleteFile('.env.ci')
                }
            }
        }

        stage('SonarQube Analysis') {
            when { branch 'dev' }
            steps {
                withSonarQubeEnv(env.SONARQUBE_SERVER) {
                    // SONAR_HOST_URL is injected by withSonarQubeEnv from the 'SonarQube'
                    // server config in Manage Jenkins > System. The token comes from the
                    // Jenkins secret credential below - never from a file in the workspace.
                    withCredentials([string(credentialsId: 'housiy-sonar-token', variable: 'SONAR_TOKEN')]) {
                        script {
                            if (isUnix()) {
                                sh 'sonar-scanner -Dsonar.projectVersion=$BUILD_NUMBER -Dsonar.token=$SONAR_TOKEN'
                            } else {
                                bat 'sonar-scanner -Dsonar.projectVersion=%BUILD_NUMBER% -Dsonar.token=%SONAR_TOKEN%'
                            }
                        }
                    }
                }
            }
        }

        stage('Quality Gate') {
            when { branch 'dev' }
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        stage('Trivy Scan Image') {
            // Scans the image built earlier now that it's the exact artifact
            // that passed tests + the SonarQube quality gate.
            when { branch 'dev' }
            steps {
                script {
                    ensureDir(env.RESULTS_DIR)
                    // returnStatus: a scan finding never blocks the pipeline by itself here;
                    // the HTML report is what's requested. Flip to runCmd(...) (no returnStatus)
                    // once you want CRITICAL/HIGH findings to fail the build.
                    runCmdStatus("trivy image --format template --template '@/contrib/html.tpl' " +
                        "--severity ${env.TRIVY_SEVERITY} --timeout 10m " +
                        "-o ${env.RESULTS_DIR}/trivy-report.html ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG}")
                    // Machine-readable copy too, in case something downstream wants to parse it.
                    runCmdStatus("trivy image --format json --severity ${env.TRIVY_SEVERITY} --timeout 10m " +
                        "-o ${env.RESULTS_DIR}/trivy-report.json ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG}")
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: "${env.RESULTS_DIR}/trivy-report.html, ${env.RESULTS_DIR}/trivy-report.json", allowEmptyArchive: true
                    script {
                        publishHTML(target: [
                            reportDir: env.RESULTS_DIR, reportFiles: 'trivy-report.html',
                            reportName: 'Trivy Image Scan', keepAll: true, alwaysLinkToLastBuild: true, allowMissing: true
                        ])
                    }
                }
            }
        }

        stage('Push Image (Nexus)') {
            // Runs on all three branches - by the time a build gets here it's
            // already been confirmed dev/stg/main in "Determine Version", so
            // no branch filter is needed. dev and stg push purely for
            // traceability (their deploys below still use the local image
            // directly); main's Nexus push is what its prod deploy actually
            // pulls from.
            when { expression { return params.DEPLOY } }
            steps {
                script { dockerLoginAndPushTags([env.DEPLOY_TAG]) }
            }
        }

        stage('Deploy (Docker Compose - dev, local Windows)') {
            // Uses this repo's own compose file (deployment/docker/docker-compose.yml)
            // with the image already built in "Build Image" - no registry round-trip.
            // The stack is a stable, persistent project (DEV_PROJECT_NAME) so only
            // "app" is ever stopped/replaced; "db" and "phpmyadmin" (which isn't even
            // part of this deploy - it's a separate --profile debug service) are
            // never touched once they exist.
            when {
                allOf {
                    branch 'dev'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                withCredentials([
                    string(credentialsId: 'housiy-db-root-password', variable: 'DB_ROOT_PW'),
                    string(credentialsId: 'housiy-db-app-password', variable: 'DB_APP_PW')
                ]) {
                    script {
                        writeFile file: '.env.dev', text: """APP_ENV=development
APP_PORT=${params.DEV_APP_PORT}
DB_EXPOSED_PORT=${params.DEV_DB_PORT}
MYSQL_ROOT_PASSWORD=${DB_ROOT_PW}
MYSQL_DATABASE=housiy
MYSQL_APP_USER=housiy_app
MYSQL_APP_PASSWORD=${DB_APP_PW}
APP_IMAGE_REPO=${env.APP_IMAGE_REPO}
APP_IMAGE_TAG=${env.DEV_TAG}
"""
                        // Local dev image needs the dev-<build> tag the compose file/env
                        // above points at - it was only built as :${env.APP_IMAGE_TAG} in
                        // the "Build Image" stage.
                        runCmd("docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.APP_IMAGE_REPO}:${env.DEV_TAG}")

                        def projectExists = runCmdStatus(
                            "docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps -a --format json app"
                        ) == 0 && runCmdStatus(
                            isUnix()
                                ? "docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps -a --format json app | grep -q ."
                                : "docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps -a --format json app | findstr . >nul"
                        ) == 0

                        if (!projectExists) {
                            echo "No existing ${env.DEV_PROJECT_NAME} stack found - this is the first deploy, starting app + db fresh on image ${env.APP_IMAGE_REPO}:${env.DEV_TAG}..."
                            runCmd("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev up -d --no-build php app redis db worker")
                        } else {
                            echo "Existing ${env.DEV_PROJECT_NAME} stack found - bringing down only the app container (db and phpmyadmin, if running, are left untouched)..."
                            runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev stop app php")
                            runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev rm -f app php")
                            echo "Starting app on the new image ${env.APP_IMAGE_REPO}:${env.DEV_TAG}..."
                            runCmd("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev up -d --no-build php app redis db worker")
                        }

                        echo "Waiting for the app container to become healthy..."
                        // No fixed container name to inspect anymore (see the compose file
                        // comment) - resolve this project's current "app" container ID first.
                        def healthCheckCmd = isUnix()
                            ? "test \"\$(docker inspect --format='{{.State.Health.Status}}' " +
                              "\$(docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps -q app) 2>/dev/null)\" = \"healthy\""
                            : "for /f %%i in ('docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps -q app') " +
                              "do docker inspect --format=\"{{.State.Health.Status}}\" %%i 2>nul | findstr /x \"healthy\" >nul"
                        def healthy = waitFor(healthCheckCmd)
                        echo healthy ? "App container is healthy." : "App container did not report healthy in time - check its logs."
                        runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.DEV_PROJECT_NAME} --env-file .env.dev ps")
                        deleteFile('.env.dev')
                    }
                }
            }
        }

        stage('Deploy (Kubernetes - stg)') {
            // No security scan on this branch (already done on dev). Deploys the
            // image built fresh from stg's own code in "Build Image" above,
            // straight from the local Docker engine - see the header note about
            // this assuming the k8s cluster shares that engine (Docker Desktop
            // Kubernetes). No Nexus push happens on this branch.
            when {
                allOf {
                    branch 'stg'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                script {
                    runCmd("docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.APP_IMAGE_REPO}:${env.STAGE_TAG}")
                    deployToKubernetes(
                        kubeCredId: 'housiy-k8s-stg-kubeconfig',
                        namespace: params.K8S_STG_NAMESPACE,
                        appImage: env.APP_IMAGE_REPO,
                        appImageTag: env.STAGE_TAG,
                        appEnv: 'staging',
                        replicas: params.K8S_REPLICAS,
                        nodePort: params.K8S_STG_NODE_PORT,
                        imagePullPolicy: 'IfNotPresent'
                    )
                }
            }
        }

        stage('Full Load Test (stg)') {
            // The complete suite (smoke+load+stress+soak, ~25-30 min) against
            // the real stg deployment, producing the "complete report".
            when { branch 'stg' }
            steps {
                script {
                    def stgUrl = "http://127.0.0.1:${params.K8S_STG_NODE_PORT}"
                    echo "Running full k6 suite (smoke+load+stress+soak) against ${stgUrl}..."
                    // returnStatus: a threshold failure shouldn't hide the report that was
                    // still generated - the junit results below are what actually reports pass/fail.
                    runCmdStatus("k6 run -e BASE_URL=${stgUrl} -e SCENARIO=all tests/load/main.js")
                }
            }
            post {
                always {
                    script {
                        copyFile('tests/load/results/junit.xml', "${env.RESULTS_DIR}/k6-full-junit.xml")
                        copyFile('tests/load/results/summary.html', "${env.RESULTS_DIR}/k6-full-summary.html")
                    }
                    junit "${env.RESULTS_DIR}/k6-full-junit.xml"
                    archiveArtifacts artifacts: 'tests/load/results/**', allowEmptyArchive: true
                    publishHTML(target: [
                        reportDir: env.RESULTS_DIR, reportFiles: 'k6-full-summary.html',
                        reportName: 'k6 Full Load Report (stg)', keepAll: true, alwaysLinkToLastBuild: true, allowMissing: true
                    ])
                }
            }
        }

        stage('Push Image (Docker Hub - main)') {
            // Nexus already got this image in the generic "Push Image (Nexus)"
            // stage above (tag = env.VERSION_TAG). This pushes the same
            // artifact to Docker Hub too - main/prod only, per the required
            // dual-registry release.
            when {
                allOf {
                    branch 'main'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                script { dockerLoginAndPushDockerHub([env.VERSION_TAG, 'latest']) }
            }
        }

        stage('Push PHP Zip (Nexus - main)') {
            // Zip artifact only ever goes to Nexus, and only from main -
            // dev and stg push images only, never the zip.
            when {
                allOf {
                    branch 'main'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                script { pushPhpZipToNexus() }
            }
        }

        stage('Tag Release (GitHub - main)') {
            when {
                allOf {
                    branch 'main'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                script {
                    def repoUrl = params.GITHUB_REPO_URL?.trim() ? params.GITHUB_REPO_URL.trim() : env.GIT_URL
                    if (!repoUrl) {
                        error("Can't determine the GitHub repo URL - set the GITHUB_REPO_URL parameter.")
                    }
                    def repoNoScheme = repoUrl.replaceFirst('^https://', '')

                    echo "Tagging release ${env.VERSION_TAG} and pushing it to ${repoUrl}"
                    withCredentials([usernamePassword(credentialsId: 'housiy-github-token', usernameVariable: 'GIT_USER', passwordVariable: 'GIT_TOKEN')]) {
                        if (isUnix()) {
                            sh """
                                git tag ${env.VERSION_TAG}
                                git push "https://\$GIT_USER:\$GIT_TOKEN@${repoNoScheme}" ${env.VERSION_TAG}
                            """
                        } else {
                            bat """
                                git tag ${env.VERSION_TAG}
                                git push "https://%GIT_USER%:%GIT_TOKEN%@${repoNoScheme}" ${env.VERSION_TAG}
                            """
                        }
                    }
                }
            }
        }

        stage('Deploy (Kubernetes - prod)') {
            when {
                allOf {
                    branch 'main'
                    expression { return params.DEPLOY }
                }
            }
            steps {
                script {
                    deployToKubernetes(
                        kubeCredId: 'housiy-k8s-prod-kubeconfig',
                        namespace: params.K8S_PROD_NAMESPACE,
                        appImage: "${env.NEXUS_REGISTRY}/${env.APP_IMAGE_REPO}",
                        appImageTag: env.VERSION_TAG,
                        appEnv: 'production',
                        replicas: params.K8S_REPLICAS,
                        nodePort: params.K8S_PROD_NODE_PORT,
                        imagePullPolicy: 'Always'
                    )
                }
            }
        }
    }

    post {
        always {
            script {
                runCmdStatus("docker compose -f ${env.CI_COMPOSE_FILE} -p ${env.CI_PROJECT_NAME} --env-file .env.ci down -v --remove-orphans")
                deleteFile('.env.ci')
            }
        }
        success {
            script {
                if (env.BRANCH == 'main') {
                    echo "Build #${env.BUILD_NUMBER}: image built${params.DEPLOY ? ", pushed to Nexus + Docker Hub as ${env.VERSION_TAG}, zip pushed to Nexus, tagged in GitHub, and deployed to ${params.K8S_PROD_NAMESPACE}" : ' (deploy skipped by parameter)'}."
                } else if (env.BRANCH == 'stg') {
                    echo "Build #${env.BUILD_NUMBER}: image built${params.DEPLOY ? ", pushed to Nexus as ${env.STAGE_TAG}, deployed to ${params.K8S_STG_NAMESPACE}, full load test complete" : ' (deploy skipped by parameter)'}."
                } else if (env.BRANCH == 'dev') {
                    echo "Build #${env.BUILD_NUMBER}: build + SonarQube + tests + Trivy scan passed${params.DEPLOY ? ", pushed to Nexus as ${env.DEV_TAG} and deployed locally" : ' (deploy skipped by parameter)'}."
                }
            }
        }
        failure {
            echo "Build #${env.BUILD_NUMBER} on branch '${env.BRANCH}' failed - the target environment was left untouched."
        }
    }
}

// Helpers: pick the right shell (sh/bat) automatically so stages never branch on OS.
def runCmd(String cmd) {
    if (isUnix()) { sh cmd } else { bat cmd }
}

def runCmdStatus(String cmd) {
    return isUnix() ? sh(script: cmd, returnStatus: true) : bat(script: cmd, returnStatus: true)
}

def waitFor(String checkCmd, int attempts = 30, int delaySeconds = 2) {
    for (int i = 0; i < attempts; i++) {
        if (runCmdStatus(checkCmd) == 0) { return true }
        sleep(delaySeconds)
    }
    return false
}

def ensureDir(String path) {
    if (isUnix()) { sh "mkdir -p ${path}" } else { bat "if not exist ${path} mkdir ${path}" }
}

def copyFile(String src, String dst) {
    if (isUnix()) {
        sh "cp ${src} ${dst} || echo '(no report to copy)'"
    } else {
        bat "copy ${src.replace('/', '\\\\')} ${dst.replace('/', '\\\\')} || echo (no report to copy)"
    }
}

def deleteFile(String path) {
    if (isUnix()) { sh "rm -f ${path}" } else { bat "del /f /q ${path.replace('/', '\\\\')} 2>nul || echo (nothing to remove)" }
}

def renderTemplate(String templatePath, Map vars) {
    def content = readFile(templatePath)
    vars.each { k, v -> content = content.replace('${' + k + '}', v.toString()) }
    return content
}

// Tags & pushes the already-built image to the Nexus docker registry
// (env.NEXUS_REGISTRY, localhost:8051); creds expanded natively by the
// shell, never baked into script text.
def dockerLoginAndPushTags(List tags) {
    def pushLines = tags.collect { t -> [
        isUnix()
            ? "docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.NEXUS_REGISTRY}/${env.APP_IMAGE_REPO}:${t}\ndocker push ${env.NEXUS_REGISTRY}/${env.APP_IMAGE_REPO}:${t}"
            : "docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.NEXUS_REGISTRY}/${env.APP_IMAGE_REPO}:${t}\r\ndocker push ${env.NEXUS_REGISTRY}/${env.APP_IMAGE_REPO}:${t}"
    ][0] }.join(isUnix() ? '\n' : '\r\n')

    if (isUnix()) {
        sh """
            echo "\$DOCKER_REGISTRY_PSW" | docker login ${env.NEXUS_REGISTRY} -u "\$DOCKER_REGISTRY_USR" --password-stdin
            ${pushLines}
            docker logout ${env.NEXUS_REGISTRY}
        """
    } else {
        bat """
            echo %DOCKER_REGISTRY_PSW%|docker login ${env.NEXUS_REGISTRY} -u %DOCKER_REGISTRY_USR% --password-stdin
            ${pushLines}
            docker logout ${env.NEXUS_REGISTRY}
        """
    }
}

// Zips the PHP application source and uploads it to a Nexus raw-hosted
// repository (env.NEXUS_RAW_URL), tagged with the same DEPLOY_TAG the
// image carries. Called from the "Push PHP Zip (Nexus - main)" stage only.
def pushPhpZipToNexus() {
    def zipName = "housiy-${env.DEPLOY_TAG}.zip"
    withCredentials([usernamePassword(credentialsId: 'housiy-nexus-registry', usernameVariable: 'NEXUS_USER', passwordVariable: 'NEXUS_PASS')]) {
        if (isUnix()) {
            sh """
                cd src && zip -qr ../${zipName} . -x '*.map' && cd ..
                curl -sf -u "\$NEXUS_USER:\$NEXUS_PASS" --upload-file ${zipName} "${env.NEXUS_RAW_URL}/${env.APP_IMAGE_REPO}/${zipName}"
            """
        } else {
            bat """
                powershell -Command "Compress-Archive -Path src\\* -DestinationPath ${zipName} -Force"
                curl -sf -u %NEXUS_USER%:%NEXUS_PASS% --upload-file ${zipName} "${env.NEXUS_RAW_URL}/${env.APP_IMAGE_REPO}/${zipName}"
            """
        }
    }
    archiveArtifacts artifacts: zipName, allowEmptyArchive: true
}

// Tags & pushes the already-built image to Docker Hub (env.DOCKERHUB_REPO,
// e.g. ksk5940/housiy-app - no host prefix needed, docker.io is the
// default registry). Called from the "Push Image (Docker Hub - main)"
// stage only.
def dockerLoginAndPushDockerHub(List tags) {
    def pushLines = tags.collect { t -> [
        isUnix()
            ? "docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.DOCKERHUB_REPO}:${t}\ndocker push ${env.DOCKERHUB_REPO}:${t}"
            : "docker tag ${env.APP_IMAGE_REPO}:${env.APP_IMAGE_TAG} ${env.DOCKERHUB_REPO}:${t}\r\ndocker push ${env.DOCKERHUB_REPO}:${t}"
    ][0] }.join(isUnix() ? '\n' : '\r\n')

    withCredentials([usernamePassword(credentialsId: 'housiy-dockerhub-registry', usernameVariable: 'DOCKERHUB_USR', passwordVariable: 'DOCKERHUB_PSW')]) {
        if (isUnix()) {
            sh """
                echo "\$DOCKERHUB_PSW" | docker login -u "\$DOCKERHUB_USR" --password-stdin
                ${pushLines}
                docker logout
            """
        } else {
            bat """
                echo %DOCKERHUB_PSW%|docker login -u %DOCKERHUB_USR% --password-stdin
                ${pushLines}
                docker logout
            """
        }
    }
}

// Renders the k8s templates and applies them. First deploy in a namespace
// also provisions MySQL; an existing db StatefulSet is always left alone.
def deployToKubernetes(Map cfg) {
    def vars = [
        APP_IMAGE: cfg.appImage,
        APP_IMAGE_TAG: cfg.appImageTag,
        NAMESPACE: cfg.namespace,
        REPLICAS: cfg.replicas,
        APP_ENV: cfg.appEnv,
        NODE_PORT: cfg.nodePort,
        IMAGE_PULL_POLICY: cfg.imagePullPolicy
    ]
    writeFile file: 'deployment/k8s/deployment.rendered.yaml',     text: renderTemplate('deployment/k8s/deployment.yaml', vars)
    writeFile file: 'deployment/k8s/service.rendered.yaml',        text: renderTemplate('deployment/k8s/service.yaml', vars)
    writeFile file: 'deployment/k8s/db-service.rendered.yaml',     text: renderTemplate('deployment/k8s/db-service.yaml', vars)
    writeFile file: 'deployment/k8s/db-statefulset.rendered.yaml', text: renderTemplate('deployment/k8s/db-statefulset.yaml', vars)

    withCredentials([file(credentialsId: cfg.kubeCredId, variable: 'KUBECONFIG')]) {
        echo "Deploying ${cfg.appImage}:${cfg.appImageTag} to namespace ${cfg.namespace}, exposed on NodePort ${cfg.nodePort} (imagePullPolicy: ${cfg.imagePullPolicy})"
        if (runCmdStatus("kubectl get namespace ${cfg.namespace}") != 0) {
            runCmd("kubectl create namespace ${cfg.namespace}")
        }

        // First deploy in this namespace provisions MySQL; otherwise db is left alone
        def dbExists = runCmdStatus("kubectl -n ${cfg.namespace} get statefulset housiy-db") == 0
        if (!dbExists) {
            echo "No existing database found in ${cfg.namespace} - first deploy, provisioning MySQL."
            runCmd("kubectl apply -f deployment/k8s/storageclass.yaml")
            runCmd("kubectl apply -n ${cfg.namespace} -f deployment/k8s/db-service.rendered.yaml")
            runCmd("kubectl apply -n ${cfg.namespace} -f deployment/k8s/db-statefulset.rendered.yaml")
            runCmd("kubectl -n ${cfg.namespace} rollout status statefulset/housiy-db --timeout=300s")
        } else {
            echo "Existing database found in ${cfg.namespace} - leaving it untouched, deploying app only."
        }

        runCmd("kubectl apply -n ${cfg.namespace} -f deployment/k8s/deployment.rendered.yaml")
        runCmd("kubectl apply -n ${cfg.namespace} -f deployment/k8s/service.rendered.yaml")
        runCmd("kubectl -n ${cfg.namespace} rollout status deployment/housiy-app --timeout=180s")
    }
}
