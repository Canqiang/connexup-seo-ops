# SEO Ops UAT Release and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Core AI SEO Ops backend and the standalone frontend to the `uat-ai` namespace with immutable image identities, least-privilege roles, safe Copilot configuration, reversible infrastructure changes, and a recorded end-to-end Only Bear acceptance proof.

**Architecture:** Core AI remains the system of record and serves `/api/seo-ops`; a separate static frontend Deployment serves `/seo-ops` on the existing Core AI UAT host through a more-specific ingress path. Release work is split into build publication, fail-closed Core AI configuration, declarative UAT manifests, ordered rollout, and independent business/API readback. Production manifests, contexts, data, and credentials are out of scope.

**Tech Stack:** GitHub Actions, Docker Hub/Buildx, Kubernetes, Nginx unprivileged, Core AI HTTP APIs, `curl`, `jq`, `kubectl`, `gh`

**Spec:** `docs/superpowers/specs/2026-08-17-seo-ops-control-plane-core-ai-uat-design.md`

## Global Constraints

- This plan starts only after the backend and frontend plans are implemented, reviewed, merged, and green.
- Work in three repositories: `/Users/xander/git_repo/core-ai`, `/Users/xander/git_repo/connexup-seo-ops`, and `/Users/xander/git_repo/fbr-env-project`.
- Use Kubernetes context `FBRDevAKSCluster` and namespace `uat-ai` explicitly on every command. Never depend on the current namespace.
- Before the first UAT mutation, obtain explicit user authorization. A previous approval to write plans or code does not authorize deployment, RBAC changes, Agent publication, or data creation.
- Never run an Azure interactive login on the user's behalf. If credentials are expired, stop at the read-only preflight and ask the user to authenticate.
- Never print, persist, commit, or include `CORE_AI_UAT_TOKEN`, Docker credentials, cookies, or session tokens in evidence.
- Deploy both application images by immutable `@sha256:` digest. Tags are discovery aids only.
- Record the prior Core AI image digest, ConfigMap values, ingress rules, and replica state before changing UAT.
- `APPROVED` remains authorization only. Acceptance must prove that the SEO Ops flow did not create an Agent Run or trigger an external GBP/site mutation.
- The Copilot Agent must be `PUBLISHED`, type `AGENT`, memory-disabled, and have zero tools, skills, sub-agents, datasets, and sandbox config before its ID is configured. Any mismatch disables Copilot rather than weakening the check.
- Merge RBAC additions into the current role map; never replace or delete unrelated roles.
- Only Bear is the positive vertical slice. UWS and Keke remain blocked until their missing identity/authorization requirements are resolved.
- Production is untouched. Do not open, edit, apply, or diff production manifests as part of this plan.

---

## Locked UAT Topology

```text
https://core-ai-server.connexup-uat.net/seo-ops/*
    -> Ingress core-ai-server, Prefix /seo-ops
    -> Service seo-ops-frontend:8080
    -> Deployment seo-ops-frontend, 2 replicas

https://core-ai-server.connexup-uat.net/api/seo-ops/*
    -> Ingress core-ai-server, Prefix /
    -> Service core-ai-server:8080
    -> Deployment core-ai-server, 2 replicas
```

## Locked Infrastructure Files

- Create `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml`.
- Modify `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/20-core-ai-server.yaml`.
- Modify `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml`.
- Create `/Users/xander/git_repo/connexup-seo-ops/scripts/uat/acceptance.sh` during frontend implementation or release preparation.
- Create `/Users/xander/git_repo/connexup-seo-ops/docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md` during release execution.

## Release Variables

Use a dedicated shell and export only non-secret values. Read the token from the environment without echoing it.

```bash
export SEO_OPS_UAT_CONTEXT=FBRDevAKSCluster
export SEO_OPS_UAT_NAMESPACE=uat-ai
export SEO_OPS_UAT_ORIGIN=https://core-ai-server.connexup-uat.net
export SEO_OPS_CORE_IMAGE=chancetop/core-ai-server
export SEO_OPS_FRONT_IMAGE=chancetop/connexup-seo-ops
test -n "$CORE_AI_UAT_TOKEN"
```

Do not set a default token. If the final command fails, stop before calling an authenticated API.

---

### Task 1: Freeze release scope and capture a read-only UAT baseline

**Files:**
- Create: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`
- Inspect: `/Users/xander/git_repo/core-ai/.github/workflows/server-build.yml`
- Inspect: `/Users/xander/git_repo/connexup-seo-ops/.github/workflows/build.yml`
- Inspect: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/20-core-ai-server.yaml`
- Inspect: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml`

- [ ] **Step 1: Verify all three repository boundaries**

```bash
git -C /Users/xander/git_repo/core-ai status --short --branch
git -C /Users/xander/git_repo/connexup-seo-ops status --short --branch
git -C /Users/xander/git_repo/fbr-env-project status --short --branch
git -C /Users/xander/git_repo/core-ai log -1 --format='%H %s'
git -C /Users/xander/git_repo/connexup-seo-ops log -1 --format='%H %s'
git -C /Users/xander/git_repo/fbr-env-project log -1 --format='%H %s'
```

Expected: planned release commits are present; unrelated changes are identified and excluded. Stop if a target manifest has unowned edits that overlap this release.

- [ ] **Step 2: Verify local release gates again**

```bash
cd /Users/xander/git_repo/core-ai
./gradlew --rerun-tasks :core-ai-server:check --no-daemon
cd /Users/xander/git_repo/connexup-seo-ops
npm ci
npm run test:run
npm run build
```

Expected: all commands exit `0`. Record test counts and build output, not tokens or environment dumps.

- [ ] **Step 3: Verify the exact UAT identity before reading cluster state**

```bash
az account show --query '{name:name,tenantId:tenantId,user:user.name}' -o json
kubectl config get-contexts
kubectl --context "$SEO_OPS_UAT_CONTEXT" cluster-info
kubectl --context "$SEO_OPS_UAT_CONTEXT" get namespace "$SEO_OPS_UAT_NAMESPACE"
```

Expected: context resolves to the UAT AKS cluster and namespace is `uat-ai`. If Azure/kube authentication is expired, stop and request interactive authentication from the user. Do not switch to another cluster.

- [ ] **Step 4: Capture deployment, routing, and image baselines**

```bash
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get deployment core-ai-server -o yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get pods -l app=core-ai-server -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image,IMAGE_ID:.status.containerStatuses[0].imageID,RESTARTS:.status.containerStatuses[0].restartCount'
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get service core-ai-server -o yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get ingress core-ai-server -o yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get configmap core-ai-server-config -o yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout history deployment/core-ai-server
```

Require all current Core AI replicas to use one runtime imageID, extract its digest, and construct an immutable rollback image:

```bash
SEO_OPS_PREVIOUS_CORE_RUNTIME_DIGEST=$(kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" \
  get pods -l app=core-ai-server -o json \
  | jq -r '[.items[].status.containerStatuses[0].imageID | split("@")[-1]] | unique | if length == 1 then .[0] else error("mixed Core AI imageIDs") end')
test "${SEO_OPS_PREVIOUS_CORE_RUNTIME_DIGEST#sha256:}" != "$SEO_OPS_PREVIOUS_CORE_RUNTIME_DIGEST"
SEO_OPS_PREVIOUS_CORE_IMAGE="$SEO_OPS_CORE_IMAGE@$SEO_OPS_PREVIOUS_CORE_RUNTIME_DIGEST"
```

Retain that value, the prior deployment image string, previous replica count, and existing ingress/config values in the evidence document. Redact any accidental secret material before committing evidence.

- [ ] **Step 5: Verify the pre-release public boundary**

```bash
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/health-check"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$SEO_OPS_UAT_ORIGIN/api/seo-ops/config"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$SEO_OPS_UAT_ORIGIN/seo-ops/"
```

Expected before release: Core AI health is `200`; SEO Ops routes are absent or disabled. Record the actual status codes without interpreting absence as a failure.

- [ ] **Step 6: Start the evidence record**

The evidence file must contain sections for repository commits, CI runs, immutable images, pre/post Kubernetes state, endpoint checks, RBAC, Copilot Agent, bootstrap identities, acceptance cases, logs, rollback coordinates, and production untouched. Use sanitized command output excerpts and UTC timestamps.

```bash
git -C /Users/xander/git_repo/connexup-seo-ops add docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md
git -C /Users/xander/git_repo/connexup-seo-ops commit -m "docs: start SEO Ops UAT evidence record"
```

### Task 2: Publish tested backend and frontend images and resolve digests

**Files:**
- Modify when required by the backend release: `/Users/xander/git_repo/core-ai/core-ai-server/VERSION`
- Inspect: `/Users/xander/git_repo/core-ai/.github/workflows/server-build.yml`
- Inspect: `/Users/xander/git_repo/connexup-seo-ops/.github/workflows/build.yml`

- [ ] **Step 1: Verify GitHub remotes, branches, and CI secrets without exposing secret values**

```bash
git -C /Users/xander/git_repo/core-ai remote -v
git -C /Users/xander/git_repo/connexup-seo-ops remote -v
gh auth status
gh secret list --repo Canqiang/connexup-seo-ops
gh secret list --repo chancetop-com/core-ai
```

Expected: both repositories have access to a `DOCKER_HUB_TOKEN` Actions secret. If the frontend secret is absent, stop and ask the user to configure it in GitHub; do not copy or recover credential material.

- [ ] **Step 2: Increment the backend patch version only after code is merged**

Use this deterministic check to compute and display the next patch version, then change `core-ai-server/VERSION` with `apply_patch` during execution:

```bash
cd /Users/xander/git_repo/core-ai
SEO_OPS_OLD_VERSION=$(tr -d '[:space:]' < core-ai-server/VERSION)
SEO_OPS_NEXT_VERSION=$(awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}' core-ai-server/VERSION)
test "$SEO_OPS_OLD_VERSION" != "$SEO_OPS_NEXT_VERSION"
printf '%s -> %s\n' "$SEO_OPS_OLD_VERSION" "$SEO_OPS_NEXT_VERSION"
```

Commit only the exact version file:

```bash
git add core-ai-server/VERSION
git commit -m "chore: release Core AI SEO Ops backend"
```

- [ ] **Step 3: Push the approved release commits and wait for CI**

```bash
git -C /Users/xander/git_repo/core-ai push origin master
git -C /Users/xander/git_repo/connexup-seo-ops push origin main
gh run list --repo chancetop-com/core-ai --workflow server-build.yml --limit 5
gh run list --repo Canqiang/connexup-seo-ops --workflow build.yml --limit 5
```

Use `gh run watch` on the run IDs associated with the exact release commits. A successful unrelated or older run is not evidence.

- [ ] **Step 4: Resolve immutable image digests from the released version tags**

```bash
SEO_OPS_CORE_VERSION=$(tr -d '[:space:]' < /Users/xander/git_repo/core-ai/core-ai-server/VERSION)
SEO_OPS_FRONT_VERSION=$(tr -d '[:space:]' < /Users/xander/git_repo/connexup-seo-ops/VERSION)
docker buildx imagetools inspect "$SEO_OPS_CORE_IMAGE:$SEO_OPS_CORE_VERSION"
docker buildx imagetools inspect "$SEO_OPS_FRONT_IMAGE:$SEO_OPS_FRONT_VERSION"
```

Set `SEO_OPS_CORE_DIGEST` and `SEO_OPS_FRONT_DIGEST` from the top-level OCI digest and verify both:

```bash
test "${SEO_OPS_CORE_DIGEST#sha256:}" != "$SEO_OPS_CORE_DIGEST"
test "${SEO_OPS_FRONT_DIGEST#sha256:}" != "$SEO_OPS_FRONT_DIGEST"
docker buildx imagetools inspect "$SEO_OPS_CORE_IMAGE@$SEO_OPS_CORE_DIGEST"
docker buildx imagetools inspect "$SEO_OPS_FRONT_IMAGE@$SEO_OPS_FRONT_DIGEST"
```

Resolve the approved linux/amd64 runtime manifest digest when the top-level object is an OCI index:

```bash
SEO_OPS_CORE_RUNTIME_DIGEST=$(docker buildx imagetools inspect --raw "$SEO_OPS_CORE_IMAGE@$SEO_OPS_CORE_DIGEST" \
  | jq -r '[.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // empty')
SEO_OPS_FRONT_RUNTIME_DIGEST=$(docker buildx imagetools inspect --raw "$SEO_OPS_FRONT_IMAGE@$SEO_OPS_FRONT_DIGEST" \
  | jq -r '[.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // empty')
test -n "$SEO_OPS_CORE_RUNTIME_DIGEST" || SEO_OPS_CORE_RUNTIME_DIGEST=$SEO_OPS_CORE_DIGEST
test -n "$SEO_OPS_FRONT_RUNTIME_DIGEST" || SEO_OPS_FRONT_RUNTIME_DIGEST=$SEO_OPS_FRONT_DIGEST
```

Record commit SHA, Actions run URL, version tag, deployment digest, and approved runtime digest as one release tuple per image.

### Task 3: Provision and independently verify the read-only Copilot Agent

**Files:**
- Modify after successful verification: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml`

- [ ] **Step 1: Obtain a fresh authenticated API token and verify its permissions**

```bash
test -n "$CORE_AI_UAT_TOKEN"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/auth/me" | jq '{user_id,name,role,permissions}'
```

Expected: an administrator identity with `agent.manage`, `agent.view`, `rbac.manage`, and `user.manage`. Do not save the bearer value or raw HTTP headers.

- [ ] **Step 2: Read the named Agent before deciding whether to create it**

```bash
curl --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/agents/name/SEO%20Ops%20Copilot"
```

If the Agent exists, compare its complete definition with the locked definition below. Do not silently update a mismatched shared Agent. Record the mismatch and obtain explicit authorization for the update. Historical Local SEO Agent IDs are not accepted as substitutes.

- [ ] **Step 3: Create the Agent only when absent and after the UAT mutation checkpoint**

Use this exact safety boundary:

```json
{
  "name": "SEO Ops Copilot",
  "description": "Internal SEO operations evidence and decision assistant; read-only and non-executing.",
  "system_prompt": "You are the internal SEO Ops Copilot. Analyze only the merchant, location, task, evidence, review, report, and causal context supplied in the conversation. Clearly separate observed facts, hypotheses, recommendations, missing evidence, and causal limitations. Never claim that correlation proves causation. Never approve, reject, revoke, dispatch, schedule, publish, edit a website or GBP profile, call an external business system, or represent that an action has executed. You have no tools. Return proposals for a human operator to review.",
  "temperature": 0.2,
  "max_turns": 4,
  "timeout_seconds": 120,
  "enable_memory": false,
  "tools": [],
  "type": "AGENT",
  "subagent_ids": [],
  "skill_ids": [],
  "sandbox_config": null,
  "dataset_config": []
}
```

POST it to `/api/agents`, capture only the returned Agent ID, then publish it with `POST /api/agents/:id/publish`.

- [ ] **Step 4: Independently read back and fail closed**

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/agents/name/SEO%20Ops%20Copilot" \
  | tee /tmp/seo-ops-copilot-readback.json \
  | jq '{id,name,type,status,enable_memory,tools,skill_ids,subagent_ids,dataset_config,sandbox_config}'
```

Acceptance predicate:

```bash
jq -e '
  .name == "SEO Ops Copilot" and
  .type == "AGENT" and
  .status == "PUBLISHED" and
  .enable_memory == false and
  (.tools | length) == 0 and
  (.skill_ids | length) == 0 and
  (.subagent_ids | length) == 0 and
  (.dataset_config | length) == 0 and
  .sandbox_config == null
' /tmp/seo-ops-copilot-readback.json
SEO_OPS_COPILOT_AGENT_ID=$(jq -r '.id' /tmp/seo-ops-copilot-readback.json)
test -n "$SEO_OPS_COPILOT_AGENT_ID"
```

Delete the temporary readback after copying its sanitized predicate output to the evidence record. If any predicate fails, leave `SYS_SEOOPS_COPILOT_AGENT_ID` empty.

### Task 4: Author and validate declarative UAT infrastructure

**Files:**
- Create: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml`
- Modify: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/20-core-ai-server.yaml`
- Modify: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml`

- [ ] **Step 1: Write the frontend Deployment and Service**

The manifest must contain:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: seo-ops-frontend
  namespace: uat-ai
spec:
  replicas: 2
  selector:
    matchLabels:
      app: seo-ops-frontend
  revisionHistoryLimit: 10
  strategy:
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  minReadySeconds: 10
  template:
    metadata:
      labels:
        app: seo-ops-frontend
    spec:
      nodeSelector:
        envpool: aiapp
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
      containers:
        - name: seo-ops-frontend
          image: chancetop/connexup-seo-ops@${SEO_OPS_FRONT_DIGEST}
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /seo-ops/healthz
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /seo-ops/healthz
              port: http
            initialDelaySeconds: 15
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: nginx-tmp
              mountPath: /tmp
      volumes:
        - name: nginx-tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: seo-ops-frontend
  namespace: uat-ai
spec:
  ports:
    - name: http
      port: 8080
      targetPort: http
  selector:
    app: seo-ops-frontend
```

The `${SEO_OPS_FRONT_DIGEST}` expression is plan notation, not committed YAML. While writing the file with `apply_patch`, replace the complete `image` value with the resolved literal from `$SEO_OPS_FRONT_IMAGE@$SEO_OPS_FRONT_DIGEST`. The frontend `nginx.conf` must place its PID and all temp paths under `/tmp` so the read-only filesystem can start.

- [ ] **Step 2: Pin the Core AI image and enable the bounded context**

Use `apply_patch` to change the Core AI image from a tag to `$SEO_OPS_CORE_IMAGE@$SEO_OPS_CORE_DIGEST`. Add only these values to the UAT ConfigMap:

```yaml
SYS_SEOOPS_ENABLED: "true"
SYS_SEOOPS_COPILOT_AGENT_ID: "the-independently-verified-agent-id"
```

Do not add an Agent ID if Task 3 did not satisfy the safety predicate; in that case use an empty string and accept Copilot-disabled UI.

- [ ] **Step 3: Add the more-specific ingress path before the catch-all path**

```yaml
- path: /seo-ops
  pathType: Prefix
  backend:
    service:
      name: seo-ops-frontend
      port:
        number: 8080
```

Keep `/` routed to `core-ai-server`. Do not add a rewrite annotation because the frontend is built and served with `/seo-ops/` as its base.

- [ ] **Step 4: Validate exact YAML resources before commit**

```bash
cd /Users/xander/git_repo/fbr-env-project
kubectl --context "$SEO_OPS_UAT_CONTEXT" apply --dry-run=client -f azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml
kubectl --context "$SEO_OPS_UAT_CONTEXT" apply --dry-run=client -f azure/uat/kube/resource/app/ai/20-core-ai-server.yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" apply --dry-run=client -f azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml
rg -n 'image: .*:latest|SEO_OPS_FRONT_DIGEST' \
  azure/uat/kube/resource/app/ai/20-core-ai-server.yaml \
  azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml
```

Expected: dry runs succeed and the final search returns no match. If `kubeconform` is installed, also run it in strict mode against all three files; absence of that optional binary is recorded, not hidden.

- [ ] **Step 5: Review the exact declarative diff and commit narrowly**

```bash
git diff --check
git diff -- azure/uat/kube/resource/app/ai/20-core-ai-server.yaml azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml
git add azure/uat/kube/resource/app/ai/20-core-ai-server.yaml azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml
git commit -m "feat(uat): deploy SEO Ops control plane"
```

### Task 5: Roll out Core AI first and prove the backend boundary

**Files:**
- Read: the three UAT manifests from Task 4
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Reconfirm authorization and target immediately before apply**

Show the user the exact infra diff, image digests, target context, namespace, new Agent ID, and rollback Core AI digest. Continue only after explicit deployment authorization.

```bash
git -C /Users/xander/git_repo/fbr-env-project push origin main
git -C /Users/xander/git_repo/fbr-env-project rev-parse HEAD
git -C /Users/xander/git_repo/fbr-env-project ls-remote origin refs/heads/main
kubectl config current-context
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" auth can-i patch deployment/core-ai-server
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" auth can-i patch configmap/core-ai-server-config
```

- [ ] **Step 2: Apply only the ConfigMap and Core AI manifest**

```bash
cd /Users/xander/git_repo/fbr-env-project
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" apply -f azure/uat/kube/resource/app/ai/config/20-core-ai-server-config.yml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" apply -f azure/uat/kube/resource/app/ai/20-core-ai-server.yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout status deployment/core-ai-server --timeout=10m
```

- [ ] **Step 3: Verify running identity, replica health, migration, and logs**

```bash
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get deployment core-ai-server
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get pods -l app=core-ai-server -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image,IMAGE_ID:.status.containerStatuses[0].imageID,RESTARTS:.status.containerStatuses[0].restartCount'
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" logs deployment/core-ai-server --since=10m --all-pods=true
```

Expected: two ready replicas; every `imageID` matches `$SEO_OPS_CORE_RUNTIME_DIGEST` (or the same single-manifest `$SEO_OPS_CORE_DIGEST`); restart counts are stable; no schema migration, codec, permission, dependency injection, or property errors are present.

- [ ] **Step 4: Prove health, authentication, feature config, and empty projections**

```bash
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/health-check"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/seo-ops/config" | jq .
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/seo-ops/portfolio" | jq .
```

Expected: config reports the bounded context enabled; Copilot reflects the live safe-Agent check rather than the presence of a raw ID; portfolio returns a valid empty or current projection.

- [ ] **Step 5: Exercise negative HTTP boundaries before any bootstrap writes**

Verify unauthenticated `/api/seo-ops/config` returns `401`. Verify a logged-in user without `seoops.view` receives `403` on portfolio. Verify an operator without `seoops.approve` receives `403` on an approval decision. Record status code and stable error code only.

### Task 6: Merge least-privilege roles and assign the initial internal users

**Files:**
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Read and preserve the current complete role map**

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/admin/rbac/roles" > /tmp/seo-ops-rbac-before.json
jq '.roles' /tmp/seo-ops-rbac-before.json
```

- [ ] **Step 2: Merge the three SEO Ops roles without deleting any existing role**

```bash
jq '
  .roles += {
    "seo_operator": ["seoops.view", "seoops.manage", "chat.use", "dashboard.view"],
    "seo_reviewer": ["seoops.view", "seoops.approve", "chat.use", "agent.view", "dashboard.view"],
    "seo_lead": ["seoops.view", "seoops.manage", "seoops.approve", "chat.use", "agent.view", "dashboard.view"]
  }
' /tmp/seo-ops-rbac-before.json > /tmp/seo-ops-rbac-merged.json
curl --fail-with-body --silent --show-error \
  -X PUT -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/seo-ops-rbac-merged.json \
  "$SEO_OPS_UAT_ORIGIN/api/admin/rbac/roles"
```

Review the JSON diff before running the PUT. The body is the full merged `RoleConfigView`; confirm all prior role keys remain.

- [ ] **Step 3: Independently read back role definitions**

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/admin/rbac/roles" > /tmp/seo-ops-rbac-after.json
jq -e '.roles.seo_operator == ["seoops.view","seoops.manage","chat.use","dashboard.view"]' /tmp/seo-ops-rbac-after.json
jq -e '.roles.seo_reviewer == ["seoops.view","seoops.approve","chat.use","agent.view","dashboard.view"]' /tmp/seo-ops-rbac-after.json
jq -e '.roles.seo_lead == ["seoops.view","seoops.manage","seoops.approve","chat.use","agent.view","dashboard.view"]' /tmp/seo-ops-rbac-after.json
```

Also compare the set of pre-existing role keys before and after; fail if any disappeared.

- [ ] **Step 4: Assign roles only to named internal UAT users approved by the user**

List users with `GET /api/auth/users`. For each explicitly approved email, set it without echoing a user list and POST the generated body to `/api/auth/users/update-role`:

```bash
test -n "$SEO_OPS_USER_EMAIL"
jq -n --arg email "$SEO_OPS_USER_EMAIL" --arg role seo_lead \
  '{email:$email,role:$role}' > /tmp/seo-ops-user-role.json
curl --fail-with-body --silent --show-error \
  -X POST -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/seo-ops-user-role.json \
  "$SEO_OPS_UAT_ORIGIN/api/auth/users/update-role"
```

Before changing a named user, record its current role as `SEO_OPS_PREVIOUS_USER_ROLE`. Do not infer recipients from merchant data or assign merchant accounts. Independently GET `/api/auth/users` and confirm the named user role. If no user list is approved, leave assignment pending and continue acceptance as the admin identity while recording that limitation.

For an approved user, resolve the active user ID from the independent users readback and prepare the bootstrap array:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/auth/users" \
  | jq '{users:[.users[] | {email,user_id,user_type,status,role,permissions}]}' \
  > /tmp/seo-ops-users-after.json
SEO_OPS_USER_ID=$(jq -r --arg email "$SEO_OPS_USER_EMAIL" \
  '.users[] | select(.email == $email and .status == "ACTIVE") | .user_id' \
  /tmp/seo-ops-users-after.json)
test -n "$SEO_OPS_USER_ID"
SEO_OPS_OPERATOR_IDS_JSON=$(jq -cn --arg id "$SEO_OPS_USER_ID" '[$id]')
```

When no user assignment was approved, set `SEO_OPS_OPERATOR_IDS_JSON='[]'`; the authenticated admin creator remains an operator automatically.

Inspect that user's `permissions` resource whitelist. An empty list is unrestricted by the existing Core AI resource policy. If it is non-empty, it must already contain `{"resource_type":"agent","resource_id":"$SEO_OPS_COPILOT_AGENT_ID"}` for Copilot session creation. Otherwise stop and request explicit authorization to merge that one resource permission through `PUT /api/auth/users/:userId/config`; preserve every existing permission and quota field, and independently read back the sanitized list. Do not clear or replace unrelated resource permissions.

### Task 7: Bootstrap three merchants with explicit readiness semantics

**Files:**
- Create or modify: `scripts/uat/acceptance.sh`
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Implement a fail-fast, token-safe acceptance script**

The script must use `set -euo pipefail`, require `CORE_AI_UAT_TOKEN`, write sanitized bodies to a `mktemp -d` directory, trap cleanup, use `curl --fail-with-body`, and never enable shell tracing. It accepts `SEO_OPS_UAT_ORIGIN` and records IDs in process variables only.

Start the script with this exact safety/temporary-file setup:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${CORE_AI_UAT_TOKEN:?CORE_AI_UAT_TOKEN is required}"
: "${SEO_OPS_UAT_ORIGIN:=https://core-ai-server.connexup-uat.net}"
: "${SEO_OPS_OPERATOR_IDS_JSON:=[]}"
SEO_OPS_TMP_DIR=$(mktemp -d)
trap 'find "$SEO_OPS_TMP_DIR" -type f -delete; rmdir "$SEO_OPS_TMP_DIR"' EXIT
SEO_OPS_ONLY_BEAR_MERCHANT_BODY="$SEO_OPS_TMP_DIR/only-bear-merchant.json"
SEO_OPS_UWS_MERCHANT_BODY="$SEO_OPS_TMP_DIR/uws-merchant.json"
SEO_OPS_KEKE_MERCHANT_BODY="$SEO_OPS_TMP_DIR/keke-merchant.json"
SEO_OPS_ONLY_BEAR_LOCATION_BODY="$SEO_OPS_TMP_DIR/only-bear-location.json"
SEO_OPS_UWS_LOCATION_BODY="$SEO_OPS_TMP_DIR/uws-location.json"
SEO_OPS_KEKE_LOCATION_BODY="$SEO_OPS_TMP_DIR/keke-location.json"
SEO_OPS_TASK_CREATE_REQUEST="$SEO_OPS_TMP_DIR/task-create-request.json"
SEO_OPS_TASK_CREATE_RESPONSE="$SEO_OPS_TMP_DIR/task-create-response.json"
SEO_OPS_EVIDENCE_BODY="$SEO_OPS_TMP_DIR/evidence.json"
SEO_OPS_UPLOADED_FILE_BODY="$SEO_OPS_TMP_DIR/uploaded-file.json"
SEO_OPS_DOWNLOADED_REPORT_BODY="$SEO_OPS_TMP_DIR/downloaded-report.html"
SEO_OPS_RUNS_BEFORE_BODY="$SEO_OPS_TMP_DIR/runs-before.json"

seo_ops_post_json() {
  local path=$1 request_file=$2 response_file=$3
  curl --fail-with-body --silent --show-error \
    -X POST -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "$SEO_OPS_UAT_ORIGIN$path" > "$response_file"
}
```

- [ ] **Step 2: Create or read back the canonical merchant records with stable idempotency keys**

Build these exact merchant bodies with the approved operator array:

```bash
jq -n --argjson operators "$SEO_OPS_OPERATOR_IDS_JSON" '{
  slug:"only-bear", display_name:"Only Bear Chicken & Boba",
  tags:["pilot","restaurant","local-seo"], operator_user_ids:$operators,
  idempotency_key:"uat-bootstrap-merchant-only-bear-v1"
}' > "$SEO_OPS_ONLY_BEAR_MERCHANT_BODY"
jq -n --argjson operators "$SEO_OPS_OPERATOR_IDS_JSON" '{
  slug:"choice-brooklyn-uws", display_name:"Choice Brooklyn UWS",
  tags:["restaurant","local-seo","blocked"], operator_user_ids:$operators,
  idempotency_key:"uat-bootstrap-merchant-uws-v1"
}' > "$SEO_OPS_UWS_MERCHANT_BODY"
jq -n --argjson operators "$SEO_OPS_OPERATOR_IDS_JSON" '{
  slug:"keke-food", display_name:"Keke Food",
  tags:["restaurant","local-seo","blocked"], operator_user_ids:$operators,
  idempotency_key:"uat-bootstrap-merchant-keke-v1"
}' > "$SEO_OPS_KEKE_MERCHANT_BODY"
seo_ops_post_json /api/seo-ops/merchants "$SEO_OPS_ONLY_BEAR_MERCHANT_BODY" "$SEO_OPS_TMP_DIR/only-bear-merchant-response.json"
seo_ops_post_json /api/seo-ops/merchants "$SEO_OPS_UWS_MERCHANT_BODY" "$SEO_OPS_TMP_DIR/uws-merchant-response.json"
seo_ops_post_json /api/seo-ops/merchants "$SEO_OPS_KEKE_MERCHANT_BODY" "$SEO_OPS_TMP_DIR/keke-merchant-response.json"
SEO_OPS_ONLY_BEAR_MERCHANT_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/only-bear-merchant-response.json")
SEO_OPS_UWS_MERCHANT_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/uws-merchant-response.json")
SEO_OPS_KEKE_MERCHANT_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/keke-merchant-response.json")
test -n "$SEO_OPS_ONLY_BEAR_MERCHANT_ID"
test -n "$SEO_OPS_UWS_MERCHANT_ID"
test -n "$SEO_OPS_KEKE_MERCHANT_ID"
```

Replay each create request to a second temporary response and assert the same resource ID is returned.

- [ ] **Step 3: Create the Only Bear positive location**

```bash
jq -n '{
  slug:"mineola", display_name:"Only Bear Mineola", timezone:"America/New_York",
  external_identities:{
    website_domain:"onlybearchickenboba.com",
    google_place_id:"ChIJgR0AKI2HwokRcMm_K7J7Phw"
  },
  readiness_status:"READY", missing_requirements:[],
  idempotency_key:"uat-bootstrap-location-only-bear-mineola-v1"
}' > "$SEO_OPS_ONLY_BEAR_LOCATION_BODY"
seo_ops_post_json "/api/seo-ops/merchants/$SEO_OPS_ONLY_BEAR_MERCHANT_ID/locations" \
  "$SEO_OPS_ONLY_BEAR_LOCATION_BODY" "$SEO_OPS_TMP_DIR/only-bear-location-response.json"
SEO_OPS_ONLY_BEAR_LOCATION_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/only-bear-location-response.json")
test -n "$SEO_OPS_ONLY_BEAR_LOCATION_ID"
```

Read it back through a task/portfolio projection and verify the exact merchant/location IDs and readiness.

- [ ] **Step 4: Create UWS and Keke as negative readiness cases**

Build and submit both blocked locations:

```bash
jq -n '{
  slug:"upper-west-side", display_name:"Choice Brooklyn UWS", timezone:"America/New_York",
  external_identities:{website_domain:"choicebrooklyn.com"}, readiness_status:"BLOCKED",
  missing_requirements:["google_place_id","gbp_authorization"],
  idempotency_key:"uat-bootstrap-location-uws-v1"
}' > "$SEO_OPS_UWS_LOCATION_BODY"
jq -n '{
  slug:"identity-pending", display_name:"Keke Food — location pending", timezone:"America/New_York",
  external_identities:{website_domain:"kekefood.us"}, readiness_status:"BLOCKED",
  missing_requirements:["canonical_location","google_place_id","gbp_authorization"],
  idempotency_key:"uat-bootstrap-location-keke-v1"
}' > "$SEO_OPS_KEKE_LOCATION_BODY"
seo_ops_post_json "/api/seo-ops/merchants/$SEO_OPS_UWS_MERCHANT_ID/locations" \
  "$SEO_OPS_UWS_LOCATION_BODY" "$SEO_OPS_TMP_DIR/uws-location-response.json"
seo_ops_post_json "/api/seo-ops/merchants/$SEO_OPS_KEKE_MERCHANT_ID/locations" \
  "$SEO_OPS_KEKE_LOCATION_BODY" "$SEO_OPS_TMP_DIR/keke-location-response.json"
SEO_OPS_UWS_LOCATION_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/uws-location-response.json")
SEO_OPS_KEKE_LOCATION_ID=$(jq -r '.id' "$SEO_OPS_TMP_DIR/keke-location-response.json")
test -n "$SEO_OPS_UWS_LOCATION_ID"
test -n "$SEO_OPS_KEKE_LOCATION_ID"
```

Do not invent Place IDs, GBP resource names, addresses, or authorization. Assert both project as blocked.

- [ ] **Step 5: Commit the reusable acceptance script before running the business slice**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
shellcheck scripts/uat/acceptance.sh
git add scripts/uat/acceptance.sh
git commit -m "test: add SEO Ops UAT acceptance flow"
```

If `shellcheck` is not installed, run `bash -n scripts/uat/acceptance.sh` and record the missing optional check.

### Task 8: Prove the Only Bear evidence-to-approval business slice

**Files:**
- Execute: `scripts/uat/acceptance.sh`
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Capture the pre-acceptance Agent Run control**

The Core AI API lists runs by Agent, so snapshot the only Agent configured for SEO Ops and sanitize it to IDs/statuses:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/runs/agent/$SEO_OPS_COPILOT_AGENT_ID/list?limit=100" \
  | jq '{total,runs:[.runs[]|{id,status,started_at}]}' \
  > "$SEO_OPS_RUNS_BEFORE_BODY"
```

This is one bounded control. The stronger proof is the task's empty Agent Run links, the no-dispatch backend integration test, and task-ID log inspection.

- [ ] **Step 2: Create one Only Bear approval task**

Build and submit the complete request with the merchant/location IDs captured in Task 7:

```bash
jq -n \
  --arg merchant_id "$SEO_OPS_ONLY_BEAR_MERCHANT_ID" \
  --arg location_id "$SEO_OPS_ONLY_BEAR_LOCATION_ID" '{
  merchant_id:$merchant_id,
  location_id:$location_id,
  definition:{
    title:"Approve Only Bear website SEO handoff",
    task_type:"WEBSITE_SEO_APPROVAL",
    source:"UAT_ACCEPTANCE",
    priority:"HIGH",
    impact:"HIGH",
    execution_spec:"Review and authorize the referenced Only Bear website SEO handoff. Authorization does not dispatch or publish any change.",
    required_evidence_types:["APPROVAL_REPORT"]
  },
  idempotency_key:"uat-acceptance-only-bear-website-approval-v1"
}' > "$SEO_OPS_TASK_CREATE_REQUEST"
seo_ops_post_json /api/seo-ops/tasks "$SEO_OPS_TASK_CREATE_REQUEST" "$SEO_OPS_TASK_CREATE_RESPONSE"
SEO_OPS_ONLY_BEAR_TASK_ID=$(jq -r '.id' "$SEO_OPS_TASK_CREATE_RESPONSE")
test -n "$SEO_OPS_ONLY_BEAR_TASK_ID"
jq -e '.task_revision >= 1 and .state_version >= 1 and (.execution_spec_hash | startswith("sha256:"))' \
  "$SEO_OPS_TASK_CREATE_RESPONSE"
```

Replay the same body and assert it returns the same task ID.

- [ ] **Step 3: Upload and append the verified approval-report file evidence**

First prove the exact local report bytes, upload them through Core AI's authenticated File API, independently download them, and prove the byte identity:

```bash
SEO_OPS_ONLY_BEAR_REPORT=/Users/xander/git_repo/fbr-agent/outputs/seo-plan-task-approval-uat/2026-08-13/only-bear/seo-plan-task-approval-report.html
SEO_OPS_EXPECTED_REPORT_SHA=9eeb8f6c9cc3ded1beb40dc43f3478933eb74843984581b174677f9982061fdb
test -f "$SEO_OPS_ONLY_BEAR_REPORT"
test "$(shasum -a 256 "$SEO_OPS_ONLY_BEAR_REPORT" | awk '{print $1}')" = "$SEO_OPS_EXPECTED_REPORT_SHA"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID" \
  > "$SEO_OPS_TMP_DIR/task-before-evidence.json"
SEO_OPS_REPORT_FILE_ID=$(jq -r --arg sha "$SEO_OPS_EXPECTED_REPORT_SHA" '
  [.evidence_refs[] | select(.type == "APPROVAL_REPORT" and .sha256 == $sha and .verification_status == "VERIFIED")][0].file_id // empty
' "$SEO_OPS_TMP_DIR/task-before-evidence.json")
if test -n "$SEO_OPS_REPORT_FILE_ID"; then
  SEO_OPS_EVIDENCE_ALREADY_PRESENT=true
  SEO_OPS_REPORT_CAPTURED_AT=$(jq -r --arg file_id "$SEO_OPS_REPORT_FILE_ID" '
    [.evidence_refs[] | select(.file_id == $file_id)][0].captured_at
  ' "$SEO_OPS_TMP_DIR/task-before-evidence.json")
else
  SEO_OPS_EVIDENCE_ALREADY_PRESENT=false
  curl --fail-with-body --silent --show-error \
    -X POST -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
    -F "file=@$SEO_OPS_ONLY_BEAR_REPORT;type=text/html" \
    "$SEO_OPS_UAT_ORIGIN/api/files" > "$SEO_OPS_UPLOADED_FILE_BODY"
  SEO_OPS_REPORT_FILE_ID=$(jq -r '.id' "$SEO_OPS_UPLOADED_FILE_BODY")
  SEO_OPS_REPORT_CAPTURED_AT=$(jq -r '.created_at' "$SEO_OPS_UPLOADED_FILE_BODY")
fi
test -n "$SEO_OPS_REPORT_FILE_ID"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/files/$SEO_OPS_REPORT_FILE_ID/content" \
  > "$SEO_OPS_DOWNLOADED_REPORT_BODY"
test "$(shasum -a 256 "$SEO_OPS_DOWNLOADED_REPORT_BODY" | awk '{print $1}')" = "$SEO_OPS_EXPECTED_REPORT_SHA"
```

Then build the evidence body from the task's actual returned state version and the independently verified File record:

```bash
if test "$SEO_OPS_EVIDENCE_ALREADY_PRESENT" = false; then
  SEO_OPS_STATE_VERSION=$(jq -r '.state_version' "$SEO_OPS_TASK_CREATE_RESPONSE")
  jq -n --argjson state "$SEO_OPS_STATE_VERSION" \
    --arg file_id "$SEO_OPS_REPORT_FILE_ID" \
    --arg captured_at "$SEO_OPS_REPORT_CAPTURED_AT" \
    --arg sha "$SEO_OPS_EXPECTED_REPORT_SHA" '{
    type:"APPROVAL_REPORT",
    file_id:$file_id,
    sha256:$sha,
    captured_at:$captured_at,
    verification_status:"VERIFIED",
    requirement_key:"APPROVAL_REPORT",
    expected_state_version:$state,
    idempotency_key:"uat-acceptance-only-bear-evidence-v1"
  }' > "$SEO_OPS_EVIDENCE_BODY"
  seo_ops_post_json "/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/evidence" \
    "$SEO_OPS_EVIDENCE_BODY" "$SEO_OPS_TMP_DIR/evidence-response.json"
  SEO_OPS_FIRST_EVIDENCE_COUNT=$(jq '[.evidence_refs[] | select(.sha256 == "9eeb8f6c9cc3ded1beb40dc43f3478933eb74843984581b174677f9982061fdb")] | length' "$SEO_OPS_TMP_DIR/evidence-response.json")
  curl --fail-with-body --silent --show-error -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
    "$SEO_OPS_UAT_ORIGIN/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/events?offset=0&limit=100" \
    > "$SEO_OPS_TMP_DIR/events-before-evidence-replay.json"
  seo_ops_post_json "/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/evidence" \
    "$SEO_OPS_EVIDENCE_BODY" "$SEO_OPS_TMP_DIR/evidence-replay-response.json"
  test "$SEO_OPS_FIRST_EVIDENCE_COUNT" = "$(jq '[.evidence_refs[] | select(.sha256 == "9eeb8f6c9cc3ded1beb40dc43f3478933eb74843984581b174677f9982061fdb")] | length' "$SEO_OPS_TMP_DIR/evidence-replay-response.json")"
  curl --fail-with-body --silent --show-error -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
    "$SEO_OPS_UAT_ORIGIN/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/events?offset=0&limit=100" \
    > "$SEO_OPS_TMP_DIR/events-after-evidence-replay.json"
  test "$(jq '.total' "$SEO_OPS_TMP_DIR/events-before-evidence-replay.json")" = \
    "$(jq '.total' "$SEO_OPS_TMP_DIR/events-after-evidence-replay.json")"
fi
```

Read the task/events after either branch and assert exactly one matching evidence/event exists.

- [ ] **Step 4: Generate a fresh approval preview**

Read the latest task. A rerun may already be approved; otherwise construct the preview from the fresh revision/state:

```bash
curl --fail-with-body --silent --show-error -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
  "$SEO_OPS_UAT_ORIGIN/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID" \
  > "$SEO_OPS_TMP_DIR/task-before-preview.json"
if test "$(jq -r '.status' "$SEO_OPS_TMP_DIR/task-before-preview.json")" = APPROVED; then
  SEO_OPS_APPROVAL_ALREADY_PRESENT=true
else
  SEO_OPS_APPROVAL_ALREADY_PRESENT=false
  jq '{task_revision:.task_revision,expected_state_version:.state_version}' \
    "$SEO_OPS_TMP_DIR/task-before-preview.json" > "$SEO_OPS_TMP_DIR/preview-request.json"
  seo_ops_post_json "/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/approval-previews" \
    "$SEO_OPS_TMP_DIR/preview-request.json" "$SEO_OPS_TMP_DIR/preview-response.json"
fi
```

For a fresh preview, assert:

- `reviewable` is true;
- blockers are empty;
- revision and state match the latest GET;
- `execution_spec_hash` exactly matches the current revision;
- impact scope says authorization only and does not advertise execution.

- [ ] **Step 5: Approve using the exact preview tuple**

For a not-yet-approved task, construct the decision from the server preview rather than a client-recomputed hash:

```bash
if test "$SEO_OPS_APPROVAL_ALREADY_PRESENT" = false; then
  jq '{
    decision:"APPROVE",
    reason:"UAT acceptance: verified Only Bear approval report; authorization only.",
    task_revision:.task_revision,
    execution_spec_hash:.execution_spec_hash,
    expected_state_version:.state_version,
    idempotency_key:"uat-acceptance-only-bear-approve-v1"
  }' "$SEO_OPS_TMP_DIR/preview-response.json" > "$SEO_OPS_TMP_DIR/decision-request.json"
  seo_ops_post_json "/api/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID/approval-decisions" \
    "$SEO_OPS_TMP_DIR/decision-request.json" "$SEO_OPS_TMP_DIR/decision-response.json"
fi
```

Do not accept a client-recomputed or stale hash. For an already approved rerun, require one stored `APPROVE` decision with the same revision/hash/reason before skipping mutation.

- [ ] **Step 6: Independently read back aggregate and event history**

Perform fresh GETs for the task and `/events`. Assert:

- status is `APPROVED`;
- `state_version` increased once;
- the stored decision records actor, time, revision, hash, expected/resulting version, and reason;
- evidence and prior revisions remain present;
- the event order is append-only;
- the evidence stores the independently verified Core AI File ID/checksum only; no transcript is copied and no unowned historical conversation link is fabricated.

- [ ] **Step 7: Replay and concurrency safety**

Replay the approval request with the same key/fingerprint and assert the same result with no duplicate decision/event. Reuse that key with a different reason and assert `409`. Submit a stale `expected_state_version` and assert `409`. Run two concurrent distinct approval decisions against the same version on a new disposable task and assert exactly one succeeds while one returns `409`.

- [ ] **Step 8: Prove blocked cases fail closed**

Create one task for UWS and one for Keke using their blocked location IDs. Assert the resulting state is `BLOCKED`; approval preview returns `reviewable=false`; blockers list the actual missing requirements; no approval decision is accepted.

- [ ] **Step 9: Prove approval did not execute**

Read `/api/runs/agent/$SEO_OPS_COPILOT_AGENT_ID/list?limit=100` again and compare the sanitized IDs with Step 1; no run may be attributable to the approval interval or SEO Ops task ID. Assert the approved task's `agent_run_links` remains empty. Search Core AI logs for the task ID and confirm no Agent dispatch, command publication, GBP mutation, website mutation, or external execution marker. Pair this with the backend integration test that counts `agent_runs` around approval. Record the result as bounded evidence: it proves the implemented path and observed UAT interval, not every external system globally.

### Task 9: Roll out the frontend and perform browser acceptance

**Files:**
- Apply: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml`
- Apply: `/Users/xander/git_repo/fbr-env-project/azure/uat/kube/resource/app/ai/20-core-ai-server.yaml`
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Apply frontend resources and the ingress path**

```bash
cd /Users/xander/git_repo/fbr-env-project
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" apply -f azure/uat/kube/resource/app/ai/37-seo-ops-frontend.yml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" apply -f azure/uat/kube/resource/app/ai/20-core-ai-server.yaml
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout status deployment/seo-ops-frontend --timeout=5m
```

- [ ] **Step 2: Verify image identity and probes**

```bash
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get deployment seo-ops-frontend
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get pods -l app=seo-ops-frontend -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image,IMAGE_ID:.status.containerStatuses[0].imageID,RESTARTS:.status.containerStatuses[0].restartCount'
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" logs deployment/seo-ops-frontend --since=10m --all-pods=true
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/seo-ops/healthz"
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/seo-ops/" > /dev/null
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/seo-ops/tasks/$SEO_OPS_ONLY_BEAR_TASK_ID" > /dev/null
```

Expected: two ready replicas; all image IDs match `$SEO_OPS_FRONT_RUNTIME_DIGEST` (or the same single-manifest `$SEO_OPS_FRONT_DIGEST`); health, root, and deep-link requests return `200`.

- [ ] **Step 3: Test login return-path behavior**

In a logged-out browser, open the Only Bear task deep link. Verify redirect to Core AI login includes only a same-origin `/seo-ops/...` return path. Log in with an internal UAT user and verify the app returns to the same task. Attempt an external `return_to` value and verify Core AI falls back to `/seo-ops/` or its safe default.

- [ ] **Step 4: Verify the portfolio-scale interaction model**

Confirm the default is portfolio mode; merchant selection uses the searchable combobox; Only Bear, UWS, and Keke show correct health/readiness; the UI does not render dozens of merchant buttons; inbox filters and pagination issue server queries; a task deep link survives refresh.

- [ ] **Step 5: Verify task, evidence, approval, review, and report surfaces**

Open the Only Bear task and compare displayed revision, hash, evidence, decision, and event history with API readback. Confirm UWS/Keke blockers are visible. Confirm users without approve permission have no formal decision controls. Confirm reviews show evidence/causal limitations and reports show reporting periods/source freshness without inventing unavailable metrics.

- [ ] **Step 6: Verify read-only Copilot behavior**

Open Copilot in Only Bear task context. Ask it to summarize missing evidence and propose a next action. Verify the linked Core AI conversation is created and read back, the task stores only the conversation ID, and the response distinguishes fact/hypothesis/recommendation. Ask it to approve or execute a GBP/site change; verify it refuses and no task decision, Agent Run with tools, or external write occurs.

- [ ] **Step 7: Check responsive and operational states**

At desktop widths, verify the dense inbox and task workspace remain readable. At narrow widths, verify drawers/panels remain navigable. Exercise loading, empty, `401`, `403`, `409`, `5xx`, and network-error states. No page may silently fall back to prototype fixtures.

- [ ] **Step 8: Record a same-volume API performance baseline**

Run 20 authenticated requests against each persisted projection after bootstrap, without logging headers or bodies:

```bash
SEO_OPS_TIMINGS_DIR=$(mktemp -d)
for SEO_OPS_ROUTE in portfolio 'inbox?offset=0&limit=50' 'reviews?offset=0&limit=50' 'reports?offset=0&limit=50'; do
  SEO_OPS_TIMING_FILE="$SEO_OPS_TIMINGS_DIR/${SEO_OPS_ROUTE%%\?*}.txt"
  for SEO_OPS_SAMPLE in {1..20}; do
    curl --fail-with-body --silent --show-error --output /dev/null \
      --write-out '%{time_total}\n' \
      -H "Authorization: Bearer $CORE_AI_UAT_TOKEN" \
      "$SEO_OPS_UAT_ORIGIN/api/seo-ops/$SEO_OPS_ROUTE" >> "$SEO_OPS_TIMING_FILE"
  done
  sort -n "$SEO_OPS_TIMING_FILE" | awk 'NR==10{p50=$1} NR==19{p95=$1} END{printf "p50=%s p95=%s samples=%d\n",p50,p95,NR}'
done
```

Record merchant/task/report/review counts alongside p50/p95. This is the comparison baseline for the same data volume and routes; it is not an invented universal SLA.

### Task 10: Restart persistence, rollback readiness, and release closure

**Files:**
- Modify: `docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md`

- [ ] **Step 1: Prove persistence across an intentional rolling restart**

After all acceptance records are captured, obtain explicit approval for the non-destructive restart, then run:

```bash
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout restart deployment/core-ai-server
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout status deployment/core-ai-server --timeout=10m
```

Read back the Only Bear task, decision, evidence, conversation link, portfolio totals, and events. All must survive with the same IDs, revision, state version, and hash.

Repeat the Task 9 timing loop after restart against the unchanged data volume. Record deltas and investigate any material shift before release closure; do not compare against a different route or row count.

- [ ] **Step 2: Verify rollback coordinates without rolling back a healthy release**

Record:

- previous and current Core AI image digests;
- current frontend digest and the command to scale it to zero/delete its ingress path;
- prior ConfigMap values for the two SEO Ops keys;
- prior ingress rule set;
- the complete sanitized pre-release RBAC role map and each changed user's prior role;
- current rollout history and replica counts.

The Core AI emergency rollback command is:

```bash
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" set image deployment/core-ai-server core-ai-server="$SEO_OPS_PREVIOUS_CORE_IMAGE"
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" rollout status deployment/core-ai-server --timeout=10m
```

The declarative rollback must then revert the UAT manifest commit and re-apply the exact prior manifest/config. Do not execute rollback merely to demonstrate it while UAT is healthy.

If RBAC/user rollback is required, first restore each changed user through `/api/auth/users/update-role`, then PUT the exact saved pre-release `RoleConfigView` to `/api/admin/rbac/roles`; independently read both back before removing the SEO Ops route. Retain `seo_*` records for audit. A newly created safe Copilot Agent may remain published but becomes unreachable when the config ID is cleared; delete it only with separate explicit authorization and only after confirming no non-SEO consumer uses it.

- [ ] **Step 3: Complete the evidence record**

Include:

- exact three repository commit SHAs;
- exact CI run URLs and conclusions;
- version tags and immutable digests;
- pre/post Pod names, image IDs, readiness, restarts, and replicas;
- endpoint status and authenticated response predicates;
- safe Copilot Agent ID/status/config predicate;
- RBAC before/after key-set proof and assigned internal users;
- merchant/location/task IDs and Only Bear approval tuple;
- UWS/Keke structured blockers;
- idempotency/concurrency/permission results;
- same-volume projection p50/p95 before and after restart;
- before/after Agent Run comparison and log boundary;
- restart persistence result;
- rollback coordinates;
- a statement that no production context or manifest was used.

- [ ] **Step 4: Run the final release audit**

```bash
git -C /Users/xander/git_repo/core-ai status --short --branch
git -C /Users/xander/git_repo/connexup-seo-ops status --short --branch
git -C /Users/xander/git_repo/fbr-env-project status --short --branch
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get deployment core-ai-server seo-ops-frontend
kubectl --context "$SEO_OPS_UAT_CONTEXT" -n "$SEO_OPS_UAT_NAMESPACE" get pods -l 'app in (core-ai-server,seo-ops-frontend)' -o wide
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/health-check"
curl --fail-with-body --silent --show-error "$SEO_OPS_UAT_ORIGIN/seo-ops/healthz"
```

Repeat the Only Bear task GET and approval-event predicate after the final health checks. A Ready Pod without this business readback does not complete the release.

- [ ] **Step 5: Commit and publish evidence only after redaction review**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
rg -n 'Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|CORE_AI_UAT_TOKEN=[^"$]|api[_-]?key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._-]{16,}|set-cookie:' docs/superpowers/evidence scripts/uat
git diff --check
git add docs/superpowers/evidence/2026-08-17-seo-ops-control-plane-uat.md scripts/uat/acceptance.sh
git commit -m "docs: record SEO Ops UAT acceptance evidence"
git push origin main
```

Expected: the secret-value scan has no matches; environment-variable references in the script are allowed. Evidence clearly separates local tests, CI publication, Kubernetes state, API truth, business acceptance, and non-execution proof.

## Rollback Triggers

Rollback the affected layer when any of these occur:

- Core AI cannot maintain two ready replicas or health fails after the timeout.
- Mongo migration, codec, dependency injection, or configuration errors appear.
- any live Pod imageID differs from the approved linux/amd64 runtime digest resolved from the deployed OCI object.
- `/api/seo-ops/config` or authenticated projections fail after Core AI rollout.
- frontend root/deep links fail, route to the wrong Service, or expose fixture data.
- RBAC merge removes an existing role or grants broader permissions than the locked roles.
- Copilot has tools, skills, sub-agents, datasets, sandbox config, memory, or performs/proposes an action as completed.
- an approval command creates an Agent Run or external mutation marker.
- idempotency or concurrent approval permits duplicate/conflicting decisions.
- restart readback loses revisions, evidence, decisions, links, events, or versions.

Rollback only the failing layer when possible. Preserve sanitized failure evidence before rollback, and independently verify the previous image/config/business path afterward.

## Completion Criteria

The UAT release is complete only when all of the following are true:

- both images are tied to exact commits, passing CI runs, version tags, digests, and live Pod imageIDs;
- backend and frontend each have two ready UAT replicas with stable restarts;
- RBAC and login return paths work for internal users;
- the Copilot safety predicate passes and the browser refusal test succeeds; if Copilot must remain disabled, record a conditional UAT rather than declaring the full release complete;
- Only Bear completes create → evidence → preview → approve → independent GET/event readback;
- UWS and Keke remain visibly blocked with truthful missing requirements;
- permission, idempotency, stale-state, and concurrency negatives pass;
- approval creates no execution Agent Run or observed external mutation;
- restart persistence succeeds;
- rollback coordinates and sanitized evidence are committed;
- production remains untouched.
