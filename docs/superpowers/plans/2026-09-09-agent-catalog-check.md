# Read-only Agent Catalog Check

Approved scope: repeatable local/remote dependency verification; no binding changes, remote publication or automatic runs. Inline execution, isolated worktree.

## Deliverable

`api/app/agent_catalog.py`: standalone CLI using existing CoreAiClient GETs and read-only SQLite. Explicit --env-file and --db, optional --baseline. JSON to stdout only; users choose where to preserve an observation. Output safe identity/status/dependency fields and configuration hashes, never prompts or credentials. No web endpoint, scheduler or second runtime registry.

## Steps

1. Baseline: `python -m pytest tests/test_coreai.py -q`.
2. Add `tests/test_agent_catalog.py`: real SQLite fixtures and HTTP MockTransport exercising the reader. Validate read-only SQL, GET-only HTTP, dependency deduplication, incomplete coverage, fixed error codes, baseline changes and no raw prompt output. Run tests and observe missing implementation.
3. Implement `read_registry(path)`, `collect_catalog(client, registry, settings, baseline=None)` and CLI. Compare registered/configured roles without altering either. Hash an explicit allowlist of execution configuration fields. Skill sharing is current visible direct references, never exclusive ownership proof. Unknown remote state must not report removal or configuration change.
4. Run new tests, CoreAiClient tests, and full backend suite. Run live against the existing database and environment with GET only, then a second observation using the first as an in-memory baseline. Report incomplete or changed state honestly.
5. Document invocation and limits. Review inline; do not merge, push or restart services.

Baseline must match schema and local role -> remote ID mapping. A mismatched identity is rejected instead of comparing unrelated environments. Skill digest changes and Agent execution-config hash changes reported separately. Timestamps / display metadata excluded from execution hash.

Limits: no runtime dynamic Skill discovery, global ownership proof, historical execution migration or PDF/PPTX generation. These remain separate subsequent work.

## Execution evidence — 2026-09-09

- Baseline CoreAiClient tests: 68 passed. Initial catalog tests failed because the module did not exist, then passed with implementation.
- Full backend suite: 1,377 passed, 8 warnings. A subsequent duplicate-baseline-role guard was independently red/green tested; final catalog plus CoreAiClient tests: 80 passed. Full suite was not rerun after that guard.
- Live GET-only observations: 165/165 visible Agents, seven registered Agents and five Skills, unchanged across paired reads. Six environment roles match; dedicated preparation role is registry-only.
- Actual CLI subprocess: exit 0; parsed JSON schema and counts verified. No remote writes, local database writes, binding switches, main merge, push or service restart.
