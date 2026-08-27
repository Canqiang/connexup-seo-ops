# SEO Ops UAT deployment

This overlay deploys one frontend plus three isolated backend roles from the
same server image. It intentionally contains no Secret values.

Before applying, the UAT operator must:

1. Replace both `:uat` image tags with immutable digests in the release patch.
2. Confirm the cluster has a `ReadWriteMany` storage class, or patch
   `seo-ops-artifacts` to the approved shared storage implementation.
3. Create `seo-ops-uat-secrets` with `DATABASE_URL`, `SESSION_SECRET`, and
   `CORE_AI_TOKEN` through the cluster's secret manager.
4. Create `seo-ops-gbp-credentials` from the approved per-location credential
   files. File names must match the `write_secret_ref` / `readback_secret_ref`
   values stored in SEO Ops; never commit those files.
5. Provision `seo-ops-uat-tls`, verify the ingress class/host, and run the
   bootstrap user Job separately with a short-lived password Secret.

Render and validate without mutating the cluster:

```bash
kubectl kustomize deploy/uat > /tmp/seo-ops-uat-rendered.yaml
kubectl apply --dry-run=client -f /tmp/seo-ops-uat-rendered.yaml
```

Apply only after the rendered manifest and image digests are reviewed:

```bash
kubectl apply -k deploy/uat
kubectl -n connexup-seo-ops-uat rollout status deployment/seo-ops-api
kubectl -n connexup-seo-ops-uat rollout status deployment/seo-ops-worker
kubectl -n connexup-seo-ops-uat rollout status deployment/seo-ops-scheduler
kubectl -n connexup-seo-ops-uat rollout status deployment/seo-ops-frontend
```

External GBP publication still requires the exact Task to pass approval and a
separate human execution confirmation. A running worker is not authorization.
