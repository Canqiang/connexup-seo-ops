# SEO Ops Core AI Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, fail-closed SEO Operations control-plane bounded context to Core AI without dispatching execution Agents or mutating external systems.

**Architecture:** `core-ai-api` owns the `/api/seo-ops` wire contract; `core-ai-server` owns a new `ai.core.server.seoops` module with three Mongo collections, task-aggregate CAS updates, RBAC, projections, and a safe Copilot configuration check. The existing Core AI background-task framework, conversation store, Agent Run store, File store, and Artifact store remain separate and are referenced by ID only.

**Tech Stack:** Java 25, core-ng WebService/RBAC, MongoDB, Jackson, JUnit 5, Mockito, Gradle

**Spec:** `docs/superpowers/specs/2026-08-17-seo-ops-control-plane-core-ai-uat-design.md`

## Global Constraints

- Work in `/Users/xander/git_repo/core-ai`; create an isolated `codex/seo-ops-core-ai` worktree at execution time.
- Preserve unrelated worktree changes and do not reuse `BackgroundTask`, `TaskModule`, or `/api/admin/tasks`.
- Use API prefix `/api/seo-ops` and snake_case JSON fields.
- Use collections `seo_merchants`, `seo_locations`, and `seo_tasks` only.
- `APPROVED` is an authorization record only; no `AgentRunner`, command publisher, MCP call, GBP call, website call, or other external mutation may be introduced.
- Core AI property `sys.seoops.enabled` and environment override `SYS_SEOOPS_ENABLED` default to false.
- Copilot is enabled only when `sys.seoops.copilot.agent-id` points to a published `AGENT` with empty tools, skills, sub-agents, and datasets, null sandbox config, and memory disabled.
- All task revisions, evidence references, approval decisions, conversation links, and events are append-only.
- Task priority values are `LOW`, `MEDIUM`, `HIGH`, `URGENT`; impact values are `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.
- Approval requires `task_revision`, `execution_spec_hash`, `expected_state_version`, and `idempotency_key` and uses one conditional Mongo update.
- All state-changing POST commands accept a nonblank idempotency key. Replaying the same key and same fingerprint returns the original result; reusing the key with different content returns `409`. The read-only approval-preview POST is not an idempotent command and carries no idempotency key.
- Large evidence, chat transcripts, reports, and Agent Run payloads remain in existing Core AI stores.
- Bound one aggregate to 50 revisions, 200 evidence references, 50 approval decisions, 50 conversation links, 100 Agent Run links, and 1,000 events. Reject a command before mutation with `409/TASK_AGGREGATE_LIMIT_REACHED`; never truncate audit history.
- Bound titles to 200 Unicode code points, execution specs to 32 KiB UTF-8, required-evidence types to 50 entries, source references to 1,024 code points, and decision reasons to 2,000 code points.
- Run `./gradlew --rerun-tasks :core-ai-server:check --no-daemon` before backend completion.

---

## Locked File Structure

### API contract

- Create `core-ai-api/src/main/java/ai/core/api/server/seoops/SeoOpsWebService.java`: endpoint annotations and method signatures.
- Create `core-ai-api/src/main/java/ai/core/api/server/seoops/SeoOpsApiModels.java`: public nested request/response/view DTOs for this bounded context.

### Domain and policy

- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoMerchant.java`: merchant identity and visible operator IDs.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoLocation.java`: location identity/readiness.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoTask.java`: task aggregate and embedded append-only records.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoTaskStatus.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoEvidenceState.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoEvidenceVerification.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoApprovalAction.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/domain/SeoLocationReadiness.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoExecutionSpecHasher.java`: canonical JSON and SHA-256.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskPolicy.java`: evidence/readiness and transition rules.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoConversationPolicy.java`: owned Core AI chat-session validation and safe link construction.

### Services and transport

- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsRuntimeConfig.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoCopilotPolicy.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoMerchantService.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsQueryService.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsViewMapper.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsWebServiceImpl.java`.
- Create `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsModule.java`.

### Wiring and migration

- Modify `core-ai-server/src/main/java/ai/core/server/ServerApp.java`: register three collections and load `SeoOpsModule`.
- Modify `core-ai-server/src/main/java/ai/core/server/rbac/PermissionCodes.java`: add view/manage/approve codes to the catalog.
- Modify `core-ai-server/src/main/resources/sys.properties`: declare disabled defaults.
- Modify `core-ai-server/src/test/resources/sys.properties`: keep SEO Ops disabled by default in broad tests.
- Create `core-ai-server/src/main/java/ai/core/server/domain/migration/SchemaMigrationVSeoOpsIndexes.java`.
- Modify `core-ai-server/src/main/java/ai/core/server/domain/migration/SchemaMigrationManager.java`: append the SEO Ops migration.

### Tests

- Create tests under `core-ai-server/src/test/java/ai/core/server/seoops/` matching each service/policy.
- Create `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsTestModule.java` and `SeoTaskMongoIntegrationTest.java` for conditional real-Mongo CAS coverage.
- Create `core-ai-server/src/test/java/ai/core/server/domain/migration/SchemaMigrationVSeoOpsIndexesTest.java`.

## Contract Types

`SeoOpsApiModels` contains public static DTO classes with public fields and `@Property` where the wire name differs. The implementer must use these exact names:

```java
public static class PageRequest {
    @QueryParam(name = "offset") public Integer offset;
    @QueryParam(name = "limit") public Integer limit;
    @QueryParam(name = "merchant_id") public String merchantId;
    @QueryParam(name = "location_id") public String locationId;
    @QueryParam(name = "status") public String status;
    @QueryParam(name = "owner_id") public String ownerId;
    @QueryParam(name = "evidence_state") public String evidenceState;
    @QueryParam(name = "report_type") public String reportType;
    @QueryParam(name = "captured_from") public String capturedFrom;
    @QueryParam(name = "captured_to") public String capturedTo;
    @QueryParam(name = "freshness") public String freshness;
}

public static class CreateMerchantRequest {
    public String slug;
    @Property(name = "display_name") public String displayName;
    public List<String> tags;
    @Property(name = "operator_user_ids") public List<String> operatorUserIds;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class CreateLocationRequest {
    public String slug;
    @Property(name = "display_name") public String displayName;
    public String timezone;
    @Property(name = "external_identities") public Map<String, String> externalIdentities;
    @Property(name = "readiness_status") public String readinessStatus;
    @Property(name = "missing_requirements") public List<String> missingRequirements;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class TaskDefinitionRequest {
    public String title;
    @Property(name = "task_type") public String taskType;
    public String source;
    public String priority;
    public String impact;
    @Property(name = "owner_id") public String ownerId;
    @Property(name = "due_at") public String dueAt;
    @Property(name = "execution_spec") public String executionSpec;
    @Property(name = "required_evidence_types") public List<String> requiredEvidenceTypes;
    @Property(name = "conversation_id") public String conversationId;
}

public static class CreateTaskRequest {
    @Property(name = "merchant_id") public String merchantId;
    @Property(name = "location_id") public String locationId;
    public TaskDefinitionRequest definition;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class CreateRevisionRequest {
    public TaskDefinitionRequest definition;
    @Property(name = "expected_state_version") public Long expectedStateVersion;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class AppendEvidenceRequest {
    public String type;
    @Property(name = "artifact_id") public String artifactId;
    @Property(name = "file_id") public String fileId;
    @Property(name = "source_ref") public String sourceRef;
    public String sha256;
    @Property(name = "captured_at") public String capturedAt;
    @Property(name = "verification_status") public String verificationStatus;
    @Property(name = "requirement_key") public String requirementKey;
    @Property(name = "expected_state_version") public Long expectedStateVersion;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class LinkConversationRequest {
    @Property(name = "conversation_id") public String conversationId;
    @Property(name = "expected_state_version") public Long expectedStateVersion;
    @Property(name = "idempotency_key") public String idempotencyKey;
}

public static class ApprovalPreviewRequest {
    @Property(name = "task_revision") public Long taskRevision;
    @Property(name = "expected_state_version") public Long expectedStateVersion;
}

public static class ApprovalDecisionRequest {
    public String decision;
    public String reason;
    @Property(name = "task_revision") public Long taskRevision;
    @Property(name = "execution_spec_hash") public String executionSpecHash;
    @Property(name = "expected_state_version") public Long expectedStateVersion;
    @Property(name = "idempotency_key") public String idempotencyKey;
}
```

View DTOs use the corresponding snake_case names and expose only IDs/summaries for conversations, Agent Runs, Files, and Artifacts. `MerchantSummaryView` exposes `operator_user_ids`, `operators: List<IdNameView>`, distinct current-task `owner_ids`, and `locations: List<LocationSummaryView>` where each location summary is `{id,display_name,readiness_status}` so the switcher and task owner field do not load all users/tasks. `TaskSummaryView` exposes `impact`. `SeoTaskView` must expose `task_revision`, `state_version`, `execution_spec_hash`, `status`, `evidence_state`, current definition, evidence refs, decisions, links, and timestamps. List responses expose `items`, `offset`, `limit`, and `total`.

Define these package-private records in the named service files so later interfaces do not depend on undeclared types:

```java
// SeoTaskCommandService.java
record ApprovalPreview(boolean reviewable, List<String> blockers, long taskRevision,
                       long stateVersion, String executionSpecHash,
                       SeoEvidenceState evidenceState, SeoTaskStatus currentStatus) {}

// SeoOpsQueryService.java
record Page<T>(List<T> items, int offset, int limit, long total) {}
record MerchantTaskCounts(long tasks, long blocked, long readyForApproval,
                          long overdue, Set<String> ownerIds) {}
record PortfolioData(List<SeoMerchant> merchants,
                     Map<String, List<SeoLocation>> locationsByMerchant,
                     Map<String, MerchantTaskCounts> countsByMerchant,
                     Map<String, String> operatorNamesById) {}
record ReviewItem(SeoTask task, String classification) {}
record ReportItem(SeoTask task, SeoTask.EvidenceRef evidence, String freshness) {}
```

---

### Task 1: Add the SEO Ops API contract and disabled module gate

**Files:**
- Create: `core-ai-api/src/main/java/ai/core/api/server/seoops/SeoOpsApiModels.java`
- Create: `core-ai-api/src/main/java/ai/core/api/server/seoops/SeoOpsWebService.java`
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsRuntimeConfig.java`
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsModule.java`
- Modify: `core-ai-server/src/main/java/ai/core/server/ServerApp.java`
- Modify: `core-ai-server/src/main/resources/sys.properties`
- Modify: `core-ai-server/src/test/resources/sys.properties`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsModuleTest.java`

**Interfaces:**
- Produces: `SeoOpsWebService`, all request/view DTOs, `SeoOpsRuntimeConfig(boolean enabled, String copilotAgentId)`.
- Produces: property keys `sys.seoops.enabled` and `sys.seoops.copilot.agent-id`.

- [ ] **Step 1: Write the failing module-gate test**

```java
@Test
void disabledModuleDoesNotRegisterWebService() {
    var module = new RecordingSeoOpsModule(Map.of("sys.seoops.enabled", "false"));
    module.initializeForTest();
    assertFalse(module.serviceRegistered);
}

@Test
void enabledModuleRegistersWebServiceAndRuntimeConfig() {
    var module = new RecordingSeoOpsModule(Map.of(
        "sys.seoops.enabled", "true",
        "sys.seoops.copilot.agent-id", "agent-safe"));
    module.initializeForTest();
    assertTrue(module.serviceRegistered);
    assertEquals("agent-safe", module.runtimeConfig.copilotAgentId());
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `./gradlew :core-ai-server:test --tests ai.core.server.seoops.SeoOpsModuleTest`

Expected: FAIL because `SeoOpsModule` and `SeoOpsRuntimeConfig` do not exist.

- [ ] **Step 3: Create the DTO contract and endpoint interface**

Define these exact methods in `SeoOpsWebService`:

```java
@GET @Path("/api/seo-ops/config") RuntimeConfigView config();
@GET @Path("/api/seo-ops/portfolio") PortfolioView portfolio();
@GET @Path("/api/seo-ops/inbox") ListTasksResponse inbox(PageRequest request);
@GET @Path("/api/seo-ops/reviews") ListReviewsResponse reviews(PageRequest request);
@GET @Path("/api/seo-ops/reports") ListReportsResponse reports(PageRequest request);
@GET @Path("/api/seo-ops/tasks/:id") SeoTaskView task(@PathParam("id") String id);
@GET @Path("/api/seo-ops/tasks/:id/events") ListEventsResponse events(@PathParam("id") String id, PageRequest request);
@POST @Path("/api/seo-ops/merchants") MerchantView createMerchant(CreateMerchantRequest request);
@POST @Path("/api/seo-ops/merchants/:id/locations") LocationView createLocation(@PathParam("id") String merchantId, CreateLocationRequest request);
@POST @Path("/api/seo-ops/tasks") SeoTaskView createTask(CreateTaskRequest request);
@POST @Path("/api/seo-ops/tasks/:id/revisions") SeoTaskView createRevision(@PathParam("id") String id, CreateRevisionRequest request);
@POST @Path("/api/seo-ops/tasks/:id/evidence") SeoTaskView appendEvidence(@PathParam("id") String id, AppendEvidenceRequest request);
@POST @Path("/api/seo-ops/tasks/:id/conversation-links") SeoTaskView linkConversation(@PathParam("id") String id, LinkConversationRequest request);
@POST @Path("/api/seo-ops/tasks/:id/approval-previews") ApprovalPreviewView approvalPreview(@PathParam("id") String id, ApprovalPreviewRequest request);
@POST @Path("/api/seo-ops/tasks/:id/approval-decisions") SeoTaskView approvalDecision(@PathParam("id") String id, ApprovalDecisionRequest request);
```

- [ ] **Step 4: Implement the disabled-by-default module**

`SeoOpsModule.initialize()` reads `property("sys.seoops.enabled").orElse("false")`. Return before binding/registering the WebService when false. When true, bind runtime config and the services listed in the locked file structure, then register `SeoOpsWebService`.

Declare in both main and test `sys.properties`:

```properties
sys.seoops.enabled=false
sys.seoops.copilot.agent-id=
```

- [ ] **Step 5: Wire `SeoOpsModule` into `ServerApp.loadDomainModules()` and rerun**

Run: `./gradlew :core-ai-server:test --tests ai.core.server.seoops.SeoOpsModuleTest`

Expected: PASS, with the disabled case registering no API service.

- [ ] **Step 6: Commit**

```bash
git add core-ai-api/src/main/java/ai/core/api/server/seoops core-ai-server/src/main/java/ai/core/server/seoops core-ai-server/src/main/java/ai/core/server/ServerApp.java core-ai-server/src/main/resources/sys.properties core-ai-server/src/test/resources/sys.properties core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsModuleTest.java
git commit -m "feat(seoops): add API contract and feature gate"
```

### Task 2: Add RBAC codes, domain documents, Mongo registration, and indexes

**Files:**
- Create: domain files listed under “Domain and policy”.
- Modify: `core-ai-server/src/main/java/ai/core/server/rbac/PermissionCodes.java`
- Modify: `core-ai-server/src/main/java/ai/core/server/ServerApp.java`
- Create: `core-ai-server/src/main/java/ai/core/server/domain/migration/SchemaMigrationVSeoOpsIndexes.java`
- Modify: `core-ai-server/src/main/java/ai/core/server/domain/migration/SchemaMigrationManager.java`
- Test: `core-ai-server/src/test/java/ai/core/server/domain/migration/SchemaMigrationVSeoOpsIndexesTest.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsDomainCodecTest.java`

**Interfaces:**
- Produces: `SEOOPS_VIEW`, `SEOOPS_MANAGE`, `SEOOPS_APPROVE` in `PermissionCodes.ALL`.
- Produces: Mongo root documents `SeoMerchant`, `SeoLocation`, `SeoTask`.

- [ ] **Step 1: Write failing permission-catalog and migration tests**

Assert all three codes are in `PermissionCodes.ALL`. Capture indexes and assert this exact coverage:

```text
seo_merchants: unique(slug), unique(creation_idempotency_key), operator_user_ids
seo_locations: unique(merchant_id, slug), unique(merchant_id, creation_idempotency_key), merchant_id + readiness_status
seo_tasks: unique(merchant_id, creation_idempotency_key)
seo_tasks: merchant_id + status + due_at
seo_tasks: owner_id + status + due_at
seo_tasks: merchant_id + updated_at(desc)
```

Use migration version `20260817001`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `./gradlew :core-ai-server:test --tests '*SeoOpsDomainCodecTest' --tests '*SchemaMigrationVSeoOpsIndexesTest'`

Expected: FAIL because domain documents, codes, and migration do not exist.

- [ ] **Step 3: Implement the domain documents**

Use core-ng `@Collection`, `@Id`, `@Field`, and `@NotNull`. Initialize all embedded lists to `new ArrayList<>()`. `SeoTask` embeds these public static classes:

```java
TaskRevision { long revision; String title; String taskType; String source; String priority; String impact;
    String ownerId; ZonedDateTime dueAt; String executionSpec; String executionSpecHash;
    List<String> requiredEvidenceTypes; String idempotencyKey; String requestFingerprint;
    String createdBy; ZonedDateTime createdAt; }
EvidenceRef { String id; long taskRevision; String type; String artifactId; String fileId;
    String sourceRef; String sha256; ZonedDateTime capturedAt; SeoEvidenceVerification verificationStatus;
    String requirementKey; String idempotencyKey; String requestFingerprint; String createdBy; ZonedDateTime createdAt; }
ApprovalDecision { String id; SeoApprovalAction decision; String reason; long taskRevision;
    String executionSpecHash; long expectedStateVersion; long resultingStateVersion;
    String idempotencyKey; String requestFingerprint; String actorId; ZonedDateTime decidedAt; }
TaskEvent { String id; String type; String actorId; String fromStatus; String toStatus;
    long taskRevision; long resultingStateVersion; String referenceId; ZonedDateTime occurredAt; }
ConversationLink { String conversationId; String relationship; String idempotencyKey; String requestFingerprint;
    String linkedBy; ZonedDateTime linkedAt; }
AgentRunLink { String agentRunId; String relationship; String linkedBy; ZonedDateTime linkedAt; }
```

Use exact enums:

```java
SeoTaskStatus: DRAFT, NEEDS_INPUT, BLOCKED, READY_FOR_APPROVAL, APPROVED, REVISION_REQUIRED, APPROVAL_REVOKED
SeoEvidenceState: NONE, PARTIAL, VERIFIED, UNVERIFIABLE
SeoEvidenceVerification: UNVERIFIED, VERIFIED, UNVERIFIABLE
SeoApprovalAction: APPROVE, REJECT, REVOKE
SeoLocationReadiness: READY, BLOCKED, INCOMPLETE
```

- [ ] **Step 4: Register collections and permission codes**

Add `mongo.collection(SeoMerchant.class)`, `mongo.collection(SeoLocation.class)`, and `mongo.collection(SeoTask.class)` in `ServerApp.registerMongo()`. Add permission constants with values `seoops.view`, `seoops.manage`, and `seoops.approve`.

- [ ] **Step 5: Implement and register the index migration**

Create indexes using `Indexes.compoundIndex`, `IndexOptions().unique(true)`, then append `new SchemaMigrationVSeoOpsIndexes()` to `operationalMigrations()`.

- [ ] **Step 6: Run focused tests**

Run: `./gradlew :core-ai-server:test --tests '*SeoOpsDomainCodecTest' --tests '*SchemaMigrationVSeoOpsIndexesTest'`

Expected: PASS and no Mongo codec exception for any embedded type.

- [ ] **Step 7: Commit**

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/domain core-ai-server/src/main/java/ai/core/server/rbac/PermissionCodes.java core-ai-server/src/main/java/ai/core/server/ServerApp.java core-ai-server/src/main/java/ai/core/server/domain/migration core-ai-server/src/test/java/ai/core/server/domain/migration/SchemaMigrationVSeoOpsIndexesTest.java core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsDomainCodecTest.java
git commit -m "feat(seoops): add persisted domain and indexes"
```

### Task 3: Implement canonical execution-spec hashing and readiness policy

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoExecutionSpecHasher.java`
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskPolicy.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoExecutionSpecHasherTest.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoTaskPolicyTest.java`

**Interfaces:**
- Produces: `String canonicalize(String rawJson)`.
- Produces: `String hash(String rawJson)` returning `sha256:<64 lowercase hex>`.
- Produces: `SeoTaskPolicy.Readiness evaluate(SeoTask task, SeoLocation location, long revision)`.

- [ ] **Step 1: Write failing deterministic-hash tests**

```java
@Test
void objectKeyOrderDoesNotChangeHash() {
    assertEquals(hasher.hash("{\"b\":2,\"a\":1}"), hasher.hash("{\"a\":1,\"b\":2}"));
}

@Test
void arrayOrderChangesHash() {
    assertNotEquals(hasher.hash("{\"x\":[1,2]}"), hasher.hash("{\"x\":[2,1]}"));
}
```

Also assert malformed JSON throws `BadRequestException` and the exact canonical fixture is `{"a":1,"b":{"c":2}}`.

- [ ] **Step 2: Write failing readiness tests**

Cover: missing location identity → `BLOCKED`; no evidence → `NONE/NEEDS_INPUT`; some verified evidence → `PARTIAL/NEEDS_INPUT`; any required evidence marked unverifiable with no valid replacement → `UNVERIFIABLE/BLOCKED`; all required types verified for the current revision → `VERIFIED/READY_FOR_APPROVAL`.

- [ ] **Step 3: Run tests and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoExecutionSpecHasherTest' --tests 'ai.core.server.seoops.SeoTaskPolicyTest'`

- [ ] **Step 4: Implement recursive canonicalization and the pure policy**

Canonicalization sorts object keys recursively, preserves array order, writes compact JSON, and hashes UTF-8 bytes. Policy counts only EvidenceRefs whose `taskRevision` equals the evaluated revision.

- [ ] **Step 5: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoExecutionSpecHasherTest' --tests 'ai.core.server.seoops.SeoTaskPolicyTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoExecutionSpecHasher.java core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskPolicy.java core-ai-server/src/test/java/ai/core/server/seoops/SeoExecutionSpecHasherTest.java core-ai-server/src/test/java/ai/core/server/seoops/SeoTaskPolicyTest.java
git commit -m "feat(seoops): enforce deterministic readiness policy"
```

### Task 4: Implement auditable merchant/location onboarding and visibility

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoMerchantService.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoMerchantServiceTest.java`

**Interfaces:**
- Produces: `SeoMerchant createMerchant(String actorUserId, CreateMerchantRequest request)`.
- Produces: `SeoLocation createLocation(String actorUserId, String merchantId, CreateLocationRequest request)`.
- Produces: `SeoMerchant requireVisibleMerchant(String actorUserId, String merchantId)`.
- Produces: `SeoLocation requireVisibleLocation(String actorUserId, String merchantId, String locationId)`.
- Produces: `List<String> visibleMerchantIds(String actorUserId)`.
- Consumes: the existing Core AI `User` collection to validate requested active operator IDs.

- [ ] **Step 1: Write failing service tests**

Cover blank slug/name/idempotency validation, slug normalization, creator inclusion in `operatorUserIds`, requested active-user validation/deduplication, same-key replay, concurrent same-key convergence, different-request key conflict, duplicate slug conflict, location ownership, and a user outside `operatorUserIds` receiving `NotFoundException`. Validate readiness enum values: `READY` requires no missing requirements and at least one nonblank external identity; `BLOCKED`/`INCOMPLETE` require at least one explicit missing requirement.

- [ ] **Step 2: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoMerchantServiceTest'`

- [ ] **Step 3: Implement the minimal service**

Normalize slugs to lowercase `[a-z0-9-]`, generate UUID IDs, store `creationIdempotencyKey` plus SHA-256 request fingerprint, and return the stored entity on an exact replay. Store the deduplicated union of the creator and requested active Core AI user IDs so UAT bootstrap can grant the approved internal team access without a fixture or direct Mongo edit. Merchant operator editing after creation remains outside this MVP.

- [ ] **Step 4: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoMerchantServiceTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoMerchantService.java core-ai-server/src/test/java/ai/core/server/seoops/SeoMerchantServiceTest.java
git commit -m "feat(seoops): add scoped merchant onboarding"
```

### Task 5: Implement task creation, revisions, and evidence CAS

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java`
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoConversationPolicy.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoTaskCommandServiceTest.java`

**Interfaces:**
- Produces: `SeoTask createTask(String actorUserId, CreateTaskRequest request)`.
- Produces: `SeoTask createRevision(String actorUserId, String taskId, CreateRevisionRequest request)`.
- Produces: `SeoTask appendEvidence(String actorUserId, String taskId, AppendEvidenceRequest request)`.
- Consumes: visibility service, hasher, task policy, task/location Mongo collections, and the existing Core AI `ChatSession` collection through `SeoConversationPolicy`.

- [ ] **Step 1: Write failing create/revision tests**

Assert creation rejects unknown priority/impact values and any `owner_id` that is not an active operator on the merchant. It writes revision 1, `taskRevision=1`, `stateVersion=1`, normalized priority/impact, canonical execution spec/hash, empty evidence/decision/Agent-Run lists, one `TASK_CREATED` event, and derived status. When `conversation_id` is present, require an owned Core AI chat session and append one `ORIGINATING_DRAFT` link without copying messages. Assert exact replay returns the same task. Assert revision requires the current `expected_state_version`, is allowed only from `DRAFT`, `NEEDS_INPUT`, `BLOCKED`, `READY_FOR_APPROVAL`, `REVISION_REQUIRED`, or `APPROVAL_REVOKED`, revalidates a changed owner, appends revision 2, counts no revision-1 evidence toward readiness, and appends `TASK_REVISED`; its optional conversation ID appends one owned `ORIGINATING_DRAFT` link in the same CAS update. The new revision enters `DRAFT` and is immediately re-evaluated; an `APPROVED` task must be revoked first.

- [ ] **Step 2: Write failing evidence tests**

Assert evidence is appendable only from `DRAFT`, `NEEDS_INPUT`, `BLOCKED`, or `READY_FOR_APPROVAL`; rejected, revoked, and approved revisions require their prescribed transition. Validate one and only one source reference (`artifact_id`, `file_id`, or `source_ref`), require SHA-256 for byte-backed File/Artifact refs, parse ISO time, bind it to the current revision, advance readiness, increment state version, and handle same/different idempotency replay. Assert title/spec/requirement/source and all aggregate-count boundaries use the locked values from Global Constraints and fail before any update.

- [ ] **Step 3: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoTaskCommandServiceTest'`

- [ ] **Step 4: Implement task creation and revision**

Create initial/revision records with canonical JSON and `sha256:` hash. Count text with `codePointCount(0, length)` and execution-spec bytes with `getBytes(StandardCharsets.UTF_8).length`; validate aggregate counts before building a Mongo update. `SeoConversationPolicy.requireOwnedChatSession(actorUserId, conversationId)` resolves only active sessions owned by the actor whose source is `chat` or `api`; browser sessions authenticated by Core AI's stored API key are recorded as `api`. The policy returns the safe ID and treats null as absent. For revisions, use a conditional update on `_id`, `state_version`, and current `task_revision`; push revision/event and an optional `ORIGINATING_DRAFT` link, set derived state, and increment both versions. On zero modified rows, reread and distinguish idempotent replay from `ConflictException`.

- [ ] **Step 5: Implement evidence CAS retry**

Read current task, check replay, add the candidate evidence in memory, evaluate readiness, and issue one update filtered by `_id`, current `task_revision`, current `state_version`, and absence of the evidence idempotency key. Retry after a lost CAS using the latest document; never replace the whole aggregate.

- [ ] **Step 6: Rerun focused tests**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoTaskCommandServiceTest'`

Expected: PASS, including stale revision and duplicate-key cases.

- [ ] **Step 7: Commit**

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java core-ai-server/src/main/java/ai/core/server/seoops/SeoConversationPolicy.java core-ai-server/src/test/java/ai/core/server/seoops/SeoTaskCommandServiceTest.java
git commit -m "feat(seoops): persist revisioned tasks and evidence"
```

### Task 6: Implement approval previews and atomic decisions

**Files:**
- Modify: `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoApprovalServiceTest.java`

**Interfaces:**
- Produces: `ApprovalPreview preview(String actorUserId, String taskId, ApprovalPreviewRequest request)`.
- Produces: `SeoTask decide(String actorUserId, String taskId, ApprovalDecisionRequest request)`.
- `ApprovalPreview` fields: `reviewable`, `blockers`, `taskRevision`, `stateVersion`, `executionSpecHash`, `evidenceState`, `currentStatus`.

- [ ] **Step 1: Write failing preview tests**

Assert missing requirements return `reviewable=false` with blockers, not an exception. Assert a stale supplied revision/state returns `ConflictException`. Assert a ready task returns its current revision/hash/state version.

- [ ] **Step 2: Write failing decision tests**

Cover:

```text
READY_FOR_APPROVAL + APPROVE -> APPROVED
READY_FOR_APPROVAL + REJECT -> REVISION_REQUIRED
APPROVED + REVOKE -> APPROVAL_REVOKED
all other action/state pairs -> 409
stale revision/hash/state -> 409
same key + same fingerprint -> original success
same key + changed reason/action/hash -> 409
REJECT or REVOKE with blank reason -> 400
```

Capture the Mongo update and assert it pushes one ApprovalDecision and one TaskEvent and increments `state_version` in the same update. Assert the service has no `AgentRunner`, `CommandPublisher`, or external-client dependency.
Also assert decision reasons above 2,000 code points and aggregates at the decision/event cap return the stable aggregate-limit error without mutation.

- [ ] **Step 3: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoApprovalServiceTest'`

- [ ] **Step 4: Implement preview and conditional decision update**

The update predicate includes `_id`, `task_revision`, `state_version`, `current_revision.execution_spec_hash`, allowed current status, and `approval_decisions.idempotency_key != submitted key`. The update pushes decision/event, sets the new status and updated time, and increments state version. On zero modified rows, reread, resolve exact idempotent replay, otherwise throw `ConflictException`.

- [ ] **Step 5: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoApprovalServiceTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java core-ai-server/src/test/java/ai/core/server/seoops/SeoApprovalServiceTest.java
git commit -m "feat(seoops): add atomic approval decisions"
```

### Task 7: Implement portfolio, inbox, reports, reviews, and event projections

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsQueryService.java`
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsViewMapper.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsQueryServiceTest.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsViewMapperTest.java`

**Interfaces:**
- Produces: `PortfolioData portfolio(String actorUserId)`.
- Produces: `Page<SeoTask> inbox(String actorUserId, PageRequest request)` with limit clamped to 1..100 and default 50.
- Produces: `Page<ReviewItem> reviews(String actorUserId, PageRequest request)`.
- Produces: `Page<ReportItem> reports(String actorUserId, PageRequest request)`.
- Produces: `SeoTask requireVisibleTask(String actorUserId, String taskId)`.
- Produces: `Page<TaskEvent> events(String actorUserId, String taskId, PageRequest request)`.

- [ ] **Step 1: Write failing query tests**

Assert all queries first constrain merchant IDs to the actor's visible set, empty visibility returns empty pages without an unbounded task scan, filters are server-side, limits cap at 100, and task detail returns `404` for an invisible merchant. A 75-merchant fixture must still use one merchant query, one batched location query, one batched active-operator name query, and bounded task aggregations rather than per-merchant reads. Portfolio summaries expose merchant operator IDs/names, distinct current-task owner IDs, and location summaries. Report projections honor merchant, location, report type, capture-time range, and freshness filters; invalid time ranges return `400`.

- [ ] **Step 2: Write failing projection tests**

Assert merchant health is `BLOCKED` when blocked count is nonzero, `ATTENTION` when overdue or ready-for-approval count is nonzero, and `STABLE` otherwise. Assert report items are produced only from evidence types ending in `_REPORT`. Freshness is `FRESH` through 7 elapsed days, `AGING` after 7 through 30 days, and `STALE` after 30 days using an injected `Clock`. Review classification is `INSUFFICIENT_EVIDENCE` when required verified facts are absent, `FACTUAL` when verified action/event evidence exists without an aligned measurement pair, `CORRELATIONAL` when verified `BASELINE_MEASUREMENT`, `INTERVENTION_RECORD`, and `POST_MEASUREMENT` exist for the current revision, and `CAUSAL_READY` only when those three plus verified `CAUSAL_DESIGN` exist. Review items never expose a causal effect estimate; Agent Run and conversation views contain IDs/relationship/status summary only.

- [ ] **Step 3: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoOpsQueryServiceTest' --tests 'ai.core.server.seoops.SeoOpsViewMapperTest'`

- [ ] **Step 4: Implement bounded queries and mappings**

Use Mongo filters/sorts/counts, not per-row lookups. The inbox sorts priority, due date, then updated time. Portfolio aggregation groups task counts by merchant/status/evidence state, attaches locations from one `merchant_id in (...)` query, and resolves the union of operator IDs with one projected User query. Reports/reviews are read-only projections over task aggregates. Inject `java.time.Clock` into the mapper/query seam so report freshness boundary tests do not depend on wall time.

- [ ] **Step 5: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoOpsQueryServiceTest' --tests 'ai.core.server.seoops.SeoOpsViewMapperTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsQueryService.java core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsViewMapper.java core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsQueryServiceTest.java core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsViewMapperTest.java
git commit -m "feat(seoops): add scoped operational projections"
```

### Task 8: Add safe Copilot config and conversation linking

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoCopilotPolicy.java`
- Modify: `core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoCopilotPolicyTest.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoConversationLinkTest.java`

**Interfaces:**
- Produces: `Optional<String> eligibleAgentId()`.
- Produces: `SeoTask linkConversation(String actorUserId, String taskId, LinkConversationRequest request)`.
- Consumes: `SeoConversationPolicy.requireOwnedChatSession(String actorUserId, String conversationId)` from Task 5.

- [ ] **Step 1: Write failing Copilot policy tests**

Given configured Agent ID, require type `AGENT`, status `PUBLISHED`, empty/null tools, skill IDs, sub-agent IDs, and dataset config, null sandbox config, and `enableMemory != true`. Every unsafe or missing case returns empty and logs only the Agent ID/reason.

- [ ] **Step 2: Write failing conversation-link tests**

Reuse `SeoConversationPolicy` to require that the Core AI ChatSession is active, belongs to the actor, and has source `chat` or `api`. For `TASK_CHAT`, additionally require that its `agent_id` equals the currently eligible safe Copilot Agent ID. Assert exact replay is idempotent, a different conversation under the same key conflicts, linking an invisible task returns `404`, relationship is `TASK_CHAT`, and only safe link metadata is stored.

- [ ] **Step 3: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoCopilotPolicyTest' --tests 'ai.core.server.seoops.SeoConversationLinkTest'`

- [ ] **Step 4: Implement policy and CAS link append**

Use the task's current `state_version` as the CAS predicate, push `ConversationLink` and `CONVERSATION_LINKED` event, and increment state version. Do not read/store ChatMessage content.

- [ ] **Step 5: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoCopilotPolicyTest' --tests 'ai.core.server.seoops.SeoConversationLinkTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoCopilotPolicy.java core-ai-server/src/main/java/ai/core/server/seoops/SeoTaskCommandService.java core-ai-server/src/test/java/ai/core/server/seoops/SeoCopilotPolicyTest.java core-ai-server/src/test/java/ai/core/server/seoops/SeoConversationLinkTest.java
git commit -m "feat(seoops): link safe Copilot conversations"
```

### Task 9: Implement the WebService, RBAC contract, and safe logs

**Files:**
- Create: `core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsWebServiceImpl.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsWebServiceImplTest.java`
- Test: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsPermissionContractTest.java`

**Interfaces:**
- Consumes: services and mapper from Tasks 4–8.
- Produces: all `/api/seo-ops` endpoints with method-level permissions.

- [ ] **Step 1: Write failing delegation/auth-context tests**

Mock `WebContext`, set `AuthContext.USER_ID_KEY` to `user-1`, call each WebService method, and verify it passes `user-1` to the correct service and maps the returned domain object.

- [ ] **Step 2: Write failing annotation contract tests**

Use reflection to assert GET/config/list/detail/event methods require `SEOOPS_VIEW`, onboarding/task/revision/evidence/conversation-link methods require `SEOOPS_MANAGE`, and preview/decision methods require `SEOOPS_APPROVE`.

- [ ] **Step 3: Run and verify failure**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoOpsWebServiceImplTest' --tests 'ai.core.server.seoops.SeoOpsPermissionContractTest'`

- [ ] **Step 4: Implement WebService methods and structured logging**

Use `AuthContext.userId(webContext)` and throw `UnauthorizedException` when absent. Log `request_id/trace_id` when present plus actor ID, merchant/task IDs, revision/state version, outcome, and error type; never log evidence body, execution spec, chat content, or authorization headers.

- [ ] **Step 5: Rerun and commit**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoOpsWebServiceImplTest' --tests 'ai.core.server.seoops.SeoOpsPermissionContractTest'`

```bash
git add core-ai-server/src/main/java/ai/core/server/seoops/SeoOpsWebServiceImpl.java core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsWebServiceImplTest.java core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsPermissionContractTest.java
git commit -m "feat(seoops): expose guarded control-plane API"
```

### Task 10: Prove Mongo persistence, concurrency, and no dispatch

**Files:**
- Create: `core-ai-server/src/test/java/ai/core/server/seoops/SeoOpsTestModule.java`
- Create: `core-ai-server/src/test/java/ai/core/server/seoops/SeoTaskMongoIntegrationTest.java`

**Interfaces:**
- Consumes: all backend services.
- Produces: conditional integration proof against `mongodb://localhost:27017/seoopstest`.

- [ ] **Step 1: Create the conditional integration module**

Register the three SEO collections, `ChatSession`, and every embedded view required by the codec. Create the same indexes as the migration in a startup hook because local Mongo runs with `notablescan=1`.

- [ ] **Step 2: Write the persisted vertical-slice test**

Using unique IDs, create merchant/location/task, append verified evidence, preview, approve, reload from Mongo, and assert revision 1, status `APPROVED`, state version progression, one approval decision, and ordered events.

- [ ] **Step 3: Write the concurrent approval test**

Submit two decisions with different idempotency keys and the same expected state from two executor threads. Assert exactly one success, one `ConflictException`, and one stored approval decision.

- [ ] **Step 4: Write the no-dispatch proof**

Count `agent_runs` before and after approval in the test database and assert unchanged. Also assert the SEO Ops package has no field or constructor dependency assignable to `AgentRunner` or `CommandPublisher`.

- [ ] **Step 5: Run integration tests**

Run: `./gradlew :core-ai-server:test --tests 'ai.core.server.seoops.SeoTaskMongoIntegrationTest'`

Expected: PASS when local Mongo is reachable; otherwise the test reports skipped through `@EnabledIf("mongoReachable")`.

- [ ] **Step 6: Run the complete Core AI gate**

Run: `./gradlew --rerun-tasks :core-ai-server:check --no-daemon`

Expected: PASS for checkstyle, PMD, SpotBugs, unit tests, and conditional integration tests.

- [ ] **Step 7: Commit**

```bash
git add core-ai-server/src/test/java/ai/core/server/seoops
git commit -m "test(seoops): prove persisted approval CAS"
```

### Task 11: Backend documentation and implementation review

**Files:**
- Modify: `docs/en/design-server-architecture.md`
- Modify: `docs/cn/design-server-architecture.md`
- Create: `docs/en/seo-ops-api.md`
- Create: `docs/cn/seo-ops-api.md`

**Interfaces:**
- Produces: developer documentation for collections, state/version semantics, RBAC, config keys, and API examples.

- [ ] **Step 1: Document the exact control-plane boundary**

Include request examples for create, evidence, preview, approval, conflict, and independent readback. State explicitly that approval does not dispatch or mutate an external system.

- [ ] **Step 2: Run unfinished-token and boundary scans**

Run:

```bash
rg -n "T[B]D|T[O]DO|F[I]XME|implement[[:space:]]+later" docs/en/seo-ops-api.md docs/cn/seo-ops-api.md
rg -n "AgentRunner|CommandPublisher|gbp|website.*write" core-ai-server/src/main/java/ai/core/server/seoops
git diff --check
```

Expected: first command has no matches; second command has no executable dispatch/write dependency; diff check passes.

- [ ] **Step 3: Run the final backend gate**

Run: `./gradlew --rerun-tasks :core-ai-server:check --no-daemon`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/en/design-server-architecture.md docs/cn/design-server-architecture.md docs/en/seo-ops-api.md docs/cn/seo-ops-api.md
git commit -m "docs(seoops): document control-plane API"
```

## Backend Completion Evidence

Before handing off to the frontend plan, record:

- backend branch and commit IDs;
- full Gradle gate output;
- optional real-Mongo test status and reason if skipped;
- exact API DTO JSON snapshots;
- proof that approval storage changes no Agent Run collection and invokes no execution dependency;
- `git status --short --branch` showing only expected branch state.
