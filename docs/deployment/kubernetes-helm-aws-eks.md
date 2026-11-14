# Housiy Kubernetes, Helm and AWS EKS deployment

## 1. Runtime layout

The Helm chart deploys:
- `housiy-app`: PHP-FPM and Nginx sidecars in one pod; Nginx serves static assets, forwards PHP API requests to FPM and proxies `/ws` to the realtime service.
- `housiy-realtime`: Node.js WebSocket gateway, authorized through `ws_auth.php`.
- `housiy-redis`: Redis event/cache service with AOF.
- `housiy-worker`: one auto-call worker replica.
- `housiy-app` Service and optional Ingress.

MySQL is external to this chart. Use a managed MySQL service such as Amazon RDS for production. The chart stores DB credentials in a Kubernetes Secret; for production prefer External Secrets/Secrets Manager integration and disable direct secret values in release history by using an externally managed Secret (adapt the chart template accordingly).

## 2. Requirements

- Kubernetes 1.27+ and Helm 3.
- Nexus Docker hosted repository reachable by all cluster nodes.
- MySQL 8 reachable from pods, schema initialized, backups enabled.
- Ingress controller and DNS/TLS configured if public ingress is needed.
- Storage class / PVC policy and monitoring configured.
- Nexus pull secret in the target namespace.

## 3. AWS EKS preparation

Create the EKS cluster using your approved VPC/subnets, private worker nodes, cluster endpoint access policy, and supported Kubernetes version. Attach worker-node permissions to pull from Nexus only through network/TLS credentials (Nexus credentials are not AWS ECR credentials).

Install/configure:
- AWS Load Balancer Controller or NGINX Ingress Controller (choose one).
- EBS CSI driver only if stateful workloads use EBS; the included chart keeps Redis data in `emptyDir`, so Redis cache is ephemeral across pod replacement. MySQL should be RDS or a separately managed durable database.
- Metrics Server and cluster monitoring.
- Network policies/security groups allowing app-to-MySQL, app/realtime/worker-to-Redis, and Nginx-to-realtime traffic.

For CI deploy, prefer GitHub OIDC or GitLab OIDC to assume a restricted AWS IAM role. Grant `eks:DescribeCluster` plus Kubernetes RBAC permissions for only the Housiy namespaces/resources. Avoid static AWS keys.

Example (run from an authenticated admin workstation; substitute actual values):

```bash
aws eks update-kubeconfig --region ap-south-1 --name YOUR_EKS_CLUSTER
kubectl get nodes
kubectl create namespace housiy-staging
kubectl create namespace housiy-production
```

## 4. Create Nexus pull secret

```bash
kubectl create secret docker-registry nexus-pull \
  --namespace housiy-staging \
  --docker-server=nexus.example.com:8051 \
  --docker-username="$NEXUS_USER" \
  --docker-password="$NEXUS_PASSWORD"

kubectl create secret docker-registry nexus-pull \
  --namespace housiy-production \
  --docker-server=nexus.example.com:8051 \
  --docker-username="$NEXUS_USER" \
  --docker-password="$NEXUS_PASSWORD"
```

## 5. Deploy with Helm

First create a private values file outside source control, e.g. `values-staging-secret.yaml` with database connection values. Restrict file permissions (`chmod 600`). Example command:

```bash
helm upgrade --install housiy deployment/helm/housiy \
  --namespace housiy-staging --create-namespace \
  --set image.registry=nexus.example.com:8051 \
  --set image.repository=housiy/housiy-app \
  --set image.tag=FULL_COMMIT_SHA \
  --set realtime.image.registry=nexus.example.com:8051 \
  --set realtime.image.repository=housiy/housiy-realtime \
  --set realtime.image.tag=FULL_COMMIT_SHA \
  --set database.host=YOUR_RDS_ENDPOINT \
  --set database.name=housiy \
  --set database.user="$DB_USER" \
  --set database.password="$DB_PASS" \
  --set redis.password="$REDIS_PASSWORD" \
  --set imagePullSecrets[0].name=nexus-pull \
  --wait --timeout 10m
```

For production use a secret manager integration instead of passing passwords on the command line (command-line arguments can be visible in shell history/process listings). Ensure the DB security group allows port 3306 from the application worker nodes/pods.

Enable Ingress by setting `ingress.enabled=true`, `ingress.host`, `ingress.className`, and `ingress.tlsSecret`. The TLS secret must already exist in the namespace. For AWS ALB, add the required AWS Load Balancer Controller annotations and configure target type/health checks according to your cluster networking.

## 6. Verify and rollback

```bash
kubectl get pods,svc,ingress -n housiy-staging
kubectl rollout status deployment/housiy-app -n housiy-staging --timeout=5m
kubectl rollout status deployment/housiy-realtime -n housiy-staging --timeout=5m
kubectl rollout status deployment/housiy-worker -n housiy-staging --timeout=5m
kubectl logs deployment/housiy-app -n housiy-staging --all-containers --tail=200
kubectl logs deployment/housiy-realtime -n housiy-staging --tail=200
helm history housiy -n housiy-staging
helm rollback housiy PREVIOUS_REVISION -n housiy-staging --wait
```

## 7. Important production notes

- Run exactly one worker replica; multiple workers are not a throughput scaling strategy unless the worker lock/partition design is explicitly validated.
- The Helm chart deploys Redis as a single-replica StatefulSet with a persistent volume claim sized by `redis.storage` (default `2Gi`). This protects AOF data across pod replacement but is not Redis HA; for HA/production use Amazon ElastiCache or a separately managed Redis service with TLS/auth and tested failover. Configure `REDIS_HOST`, password and prefix consistently in app, worker and gateway.
- Do not scale the realtime gateway horizontally until its Redis pub/sub fan-out, connection limits, ingress idle timeouts and reconnect/snapshot behavior have been tested in the target cluster.
- Configure PodDisruptionBudgets, resource requests/limits, HPA only after load testing, topology spread, network policies, TLS, backups, alerts and log retention for production.
- Do not expose MySQL or Redis with public LoadBalancer/NodePort services.
- Kubernetes readiness is not equivalent to full application correctness. Execute the Housiy smoke, room-isolation, block/unblock, room-deletion, rematch, winner-claim and WebSocket outage-recovery tests after deployment.

### Database setup

`sql/schema.sql` is the consolidated schema for new installations. For an existing database, compare its table definitions with this schema and apply a reviewed, backed-up migration for any missing columns; no standalone migration SQL is included in this release.
