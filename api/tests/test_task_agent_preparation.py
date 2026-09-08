import copy
import hashlib
import json
from datetime import datetime, timedelta, timezone

import pytest

from test_task_assignment import assign, seed_agent
from test_tasks import (make_merchant, make_task, verified_agent_result,
                        override_preparation_llm_call, clear_preparation_llm_call,
                        execution_binding)


def hash_value(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def safe_config():
    return dict(id='external-agent', type='AGENT', status='PUBLISHED',
                published_at='2026-09-08T00:00:00Z', updated_at='2026-09-08T00:00:00Z',
                tools=[], skill_ids=[], subagent_ids=[], sandbox_config=None,
                dataset_config=[], enable_memory=False, model='test-model',
                system_prompt='Prepare only', system_prompt_id=None, response_schema='{}',
                input_template=None, variables=None, temperature=0.2, max_turns=1,
                timeout_seconds=180, thinking_effort=None, multi_modal_model=None,
                prefer_caption_path=None)


class AgentBoundary:
    def __init__(self):
        self.config = safe_config()
        self.calls = []
        self.output = verified_agent_result()
        self.status = 'COMPLETED'
        self.agent_id = 'external-agent'
        self.before_trigger = None
        self.before_get = None

    def get_agent(self, agent_id):
        assert agent_id == 'external-agent'
        if self.before_get:
            self.before_get()
        return copy.deepcopy(self.config)

    def trigger(self, agent_id, input_text):
        self.calls.append((agent_id, input_text))
        if self.before_trigger:
            self.before_trigger()
        return {'run_id': 'new-task-run', 'status': 'RUNNING'}

    def get_run(self, run_id):
        assert run_id == 'new-task-run'
        return dict(id=run_id, agent_id=self.agent_id, status=self.status,
                    input=self.calls[0][1], output=self.output, error=None)

    def llm_call(self, *args):
        raise AssertionError('Agent must never fall back to LLM Call')


@pytest.fixture
def assigned(client, monkeypatch):
    task = make_task(client, make_merchant(client)['id'])
    local_id = seed_agent()
    fake = AgentBoundary()
    monkeypatch.setenv('SEO_OPS_TASK_AGENT_BINDINGS', json.dumps({local_id: {
        'coreai_agent_id': 'external-agent', 'config_sha256': hash_value(safe_config())}}))
    assert assign(client, task, 'AGENT', local_id).status_code == 200
    override_preparation_llm_call(fake)
    try:
        yield client.get(f"/api/tasks/{task['id']}").json(), fake
    finally:
        clear_preparation_llm_call()


def start(client, task):
    return client.post(f"/api/tasks/{task['id']}/execute", json={'expected_version': task['version']})


def test_agent_dispatch_persists_run_and_cannot_double_start(client, assigned):
    task, fake = assigned
    response = start(client, task)
    assert response.status_code == 201, response.text
    assert response.json()['status'] == 'RUNNING'
    assert response.json()['coreai_run_id'] == 'new-task-run'
    assert response.json()['request']['coreai_agent_id'] == 'external-agent'
    assert len(fake.calls) == 1
    assert start(client, task).status_code == 409
    assert len(fake.calls) == 1


def test_agent_completed_requires_am_approval(client, assigned):
    from app.scheduler import poll_task_executions_once
    task, fake = assigned
    assert start(client, task).status_code == 201
    poll_task_executions_once(fake)
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail['status'] == 'AWAITING_APPROVAL'
    assert detail['executions'][-1]['preparation_trust'] == 'REVIEWABLE'
    events = len(detail['events'])
    poll_task_executions_once(fake)
    assert len(client.get(f"/api/tasks/{task['id']}").json()['events']) == events
    r = client.post(f"/api/tasks/{task['id']}/approve-execution", json=execution_binding(detail))
    assert r.status_code == 200, r.text
    assert client.get(f"/api/tasks/{task['id']}").json()['status'] == 'DONE'


@pytest.mark.parametrize('field,value', [('tools',[{'id':'write'}]), ('skill_ids',['skill']),
    ('subagent_ids',['child']), ('sandbox_config',{}), ('dataset_config',[{}]),
    ('enable_memory',True), ('system_prompt','changed'), ('published_at','2026-09-07T00:00:00Z')])
def test_unsafe_or_changed_config_never_triggers(client, assigned, field, value):
    task, fake = assigned
    fake.config[field] = value
    response = start(client, task)
    assert response.status_code == 409
    assert fake.calls == []
    assert client.get(f"/api/tasks/{task['id']}").json()['executions'] == []


def test_missing_binding_never_triggers(client, assigned, monkeypatch):
    task, fake = assigned
    monkeypatch.delenv('SEO_OPS_TASK_AGENT_BINDINGS')
    assert start(client, task).status_code == 409
    assert fake.calls == []


def test_ambiguous_trigger_is_unknown_and_never_retried(client, assigned):
    from app.coreai import CoreAiError
    task, fake = assigned
    def fail():
        raise CoreAiError(0, 'timeout')
    fake.before_trigger = fail
    response = start(client, task)
    assert response.status_code == 201, response.text
    assert response.json()['status'] == 'UNKNOWN'
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail['status'] == 'NEEDS_ATTENTION'
    assert detail['executions'][-1]['preparation_trust'] == 'UNTRUSTED'
    assert start(client, detail).status_code == 409
    assert len(fake.calls) == 1


@pytest.mark.parametrize('mutation', ['identity', 'output', 'config'])
def test_unverified_completion_cannot_be_approved(client, assigned, mutation):
    from app.scheduler import poll_task_executions_once
    task, fake = assigned
    assert start(client, task).status_code == 201
    if mutation == 'identity': fake.agent_id = 'different-agent'
    if mutation == 'output': fake.output = 'not JSON'
    if mutation == 'config': fake.config['tools'] = [{'id':'write'}]
    poll_task_executions_once(fake)
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail['status'] == 'NEEDS_ATTENTION'
    assert detail['executions'][-1]['preparation_trust'] == 'UNTRUSTED'


def test_duplicate_remote_id_stops_second_task(client, assigned):
    task, fake = assigned
    assert start(client, task).status_code == 201
    second = make_task(client, task['merchant_id'])
    assert assign(client, second, 'AGENT', task['assignment']['assignee_id']).status_code == 200
    second = client.get(f"/api/tasks/{second['id']}").json()
    r = start(client, second)
    assert r.status_code == 201
    assert r.json()['status'] == 'UNKNOWN'


def test_task_change_during_preflight_prevents_dispatch(client, assigned):
    from app.db import connect
    task, fake = assigned
    def change():
        with connect() as conn: conn.execute('UPDATE tasks SET version=version+1 WHERE id=?',(task['id'],))
    fake.before_get = change
    assert start(client, task).status_code == 409
    assert fake.calls == []


def test_connection_only_scheduler_reconciles_agent(client, assigned, monkeypatch):
    import asyncio
    from app import scheduler
    task, fake = assigned
    assert start(client, task).status_code == 201
    monkeypatch.setattr(scheduler, 'coreai_settings', lambda: None)
    monkeypatch.setenv('COREAI_BASE_URL', 'http://unused.invalid')
    monkeypatch.setenv('COREAI_API_KEY', 'test-only')
    monkeypatch.setattr(scheduler, 'CoreAiClient', lambda *args: fake)
    class StopTick(Exception): pass
    async def stop(_): raise StopTick
    monkeypatch.setattr(scheduler.asyncio, 'sleep', stop)
    with pytest.raises(StopTick): asyncio.run(scheduler.scheduler_loop())
    assert client.get(f"/api/tasks/{task['id']}").json()['status'] == 'AWAITING_APPROVAL'


def test_stale_agent_dispatch_recovers_without_retrigger(client, assigned):
    from app.db import connect
    from app.scheduler import recover_stale_task_dispatches_once
    task, fake = assigned
    assert start(client, task).status_code == 201
    with connect() as conn:
        conn.execute("UPDATE task_executions SET status='DISPATCHING',coreai_run_id=NULL,dispatch_started_at=? WHERE task_id=?",
                     ((datetime.now(timezone.utc)-timedelta(minutes=16)).isoformat(),task['id']))
    recover_stale_task_dispatches_once()
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail['status'] == 'NEEDS_ATTENTION'
    assert detail['executions'][-1]['status'] == 'UNKNOWN'
    assert 'LLM' not in detail['executions'][-1]['error']
    assert len(fake.calls) == 1


def test_mutated_evidence_is_not_reviewable(client, assigned):
    from app.db import connect
    from app.scheduler import poll_task_executions_once
    task, fake = assigned
    assert start(client, task).status_code == 201
    poll_task_executions_once(fake)
    detail = client.get(f"/api/tasks/{task['id']}").json()
    with connect() as conn:
        conn.execute("UPDATE task_executions SET evidence_json='[]' WHERE task_id=?",(task['id'],))
    assert client.post(f"/api/tasks/{task['id']}/approve-execution", json=execution_binding(detail)).status_code == 409


def test_agent_dependency_does_not_require_llm_or_planning_agent(client, assigned, monkeypatch):
    from app import tasks
    task, fake = assigned
    clear_preparation_llm_call()
    monkeypatch.setenv('COREAI_BASE_URL', 'http://unused.invalid')
    monkeypatch.setenv('COREAI_API_KEY', 'test-only')
    for name in ('COREAI_AGENT_ID', 'COREAI_ORCHESTRATOR_AGENT_ID', 'COREAI_PREPARATION_LLM_CALL_ID'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(tasks, '_execution_client', fake)
    assert start(client, task).status_code == 201
    assert len(fake.calls) == 1


def test_archive_during_completion_does_not_revive_task(client, assigned):
    from app.db import connect
    from app.merchants import _append_status_event, now_iso
    from app.scheduler import poll_task_executions_once
    task, fake = assigned
    assert start(client, task).status_code == 201
    # The public API already rejects archiving active work. Simulate a separate
    # lifecycle writer to also verify the reconciliation fence itself.
    assert client.patch(f"/api/merchants/{task['merchant_id']}", json={'status':'archived'}).status_code == 409
    def archive():
        with connect() as conn:
            conn.execute("UPDATE merchants SET status='archived' WHERE id=?", (task['merchant_id'],))
            _append_status_event(conn, merchant_id=task['merchant_id'], status='archived',
                                 generation=2, stamp=now_iso(), actor='test', reason='race-fixture')
    fake.before_get = archive
    poll_task_executions_once(fake)
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail['status'] != 'AWAITING_APPROVAL'
    assert detail['executions'][-1]['preparation_trust'] == 'UNTRUSTED'


@pytest.mark.parametrize('field', ['tools','skill_ids','subagent_ids','sandbox_config','dataset_config','enable_memory'])
def test_missing_capability_field_is_not_treated_as_disabled(client, assigned, field):
    task, fake = assigned
    del fake.config[field]
    assert start(client, task).status_code == 409
    assert fake.calls == []


def test_simultaneous_start_claims_once(client, assigned):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    task, fake = assigned
    barrier = Barrier(2)
    fake.before_get = lambda: barrier.wait(timeout=5)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: start(client, task), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert len(fake.calls) == 1
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert len(detail['executions']) == 1
    assert detail['executions'][0]['coreai_run_id'] == 'new-task-run'
