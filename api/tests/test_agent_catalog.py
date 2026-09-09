import json
import sqlite3

import httpx
import pytest

from app.coreai import CoreAiClient


def collect(*, total=2, fail=False, prompt='private prompt', baseline=None,
            digest='digest-1', settings=None, malformed=False, skill_fail=False):
    from app.agent_catalog import collect_catalog

    def handle(request):
        assert request.method == 'GET'
        path = request.url.path
        if path == '/api/agents':
            if malformed:
                return httpx.Response(200, json={'total': True, 'agents': []})
            return httpx.Response(200, json={'total': total, 'agents': [
                {'id': 'a', 'skill_ids': ['s'], 'skills': [{'id': 's'}]},
                {'id': 'other', 'skill_ids': ['s']},
            ]})
        if path == '/api/agents/a':
            if fail:
                return httpx.Response(503, text='private failure secret')
            return httpx.Response(200, json={'id': 'a', 'status': 'PUBLISHED',
                'name': 'Agent', 'system_prompt': prompt, 'skill_ids': ['s'],
                'skills': [{'id': 's'}], 'tools': None})
        if path == '/api/skills/s':
            if skill_fail:
                return httpx.Response(404, text='private skill secret')
            return httpx.Response(200, json={'id': 's', 'qualified_name': 'team/skill',
                                           'digest': digest})
        raise AssertionError(path)

    c = CoreAiClient('https://test.invalid', 'private-token', transport=httpx.MockTransport(handle))
    try:
        return collect_catalog(c, [{'agent_key': 'diagnosis-plan', 'coreai_agent_id': 'a',
                                    'status': 'active'}], settings if settings is not None else
                               {'COREAI_AGENT_ID': 'a'}, baseline)
    finally:
        c.close()


def test_collect_deduplicates_shared_references_and_hides_prompt():
    result = collect()
    assert result['coverage']['complete'] is True
    assert result['skills'][0]['visible_agent_ids'] == ['a', 'other']
    assert result['skills'][0]['shared_observed'] is True
    assert result['agents'][0]['binding_state'] == 'matches'
    assert 'private' not in json.dumps(result)


def test_incomplete_list_is_not_global_coverage():
    assert collect(total=3)['coverage']['complete'] is False


def test_skill_digest_change_independent_of_agent_config():
    result = collect(digest='digest-2', baseline=collect())
    assert result['agents'][0]['change'] == 'unchanged'
    assert result['skills'][0]['change'] == 'changed'


def test_binding_mismatch_does_not_switch_agent():
    result = collect(settings={'COREAI_AGENT_ID': 'wrong'})
    assert result['agents'][0]['binding_state'] == 'mismatch'
    assert result['agents'][0]['coreai_agent_id'] == 'a'


def test_registry_only_is_not_obsolete():
    assert collect(settings={})['agents'][0]['binding_state'] == 'registry_only'


def test_malformed_list_and_missing_skill_preserve_unknown():
    result = collect(malformed=True, skill_fail=True)
    assert result['coverage']['complete'] is False
    assert result['coverage']['error'] == 'AGENT_LIST_UNAVAILABLE'
    assert result['skills'][0]['change'] == 'unknown'
    assert result['skills'][0]['error'] == 'SKILL_READ_FAILED'
    assert 'private' not in json.dumps(result)


def test_cli_missing_configuration_fails_without_creating_database(tmp_path, capsys):
    from app.agent_catalog import main
    db = tmp_path / 'absent.db'
    assert main(['--db', str(db), '--env-file', str(tmp_path / 'absent.env')]) == 2
    assert not db.exists()
    assert capsys.readouterr().err.strip() == '{"error":"CATALOG_CHECK_FAILED"}'


def test_failure_is_unknown_not_removal_and_does_not_leak():
    result = collect(fail=True, baseline=collect())
    assert result['agents'][0]['change'] == 'unknown'
    assert result['agents'][0]['error'] == 'AGENT_READ_FAILED'
    assert 'private' not in json.dumps(result)


def test_config_change_and_unchanged_baseline():
    first = collect()
    assert collect(baseline=first)['agents'][0]['change'] == 'unchanged'
    assert collect(prompt='different', baseline=first)['agents'][0]['change'] == 'changed'


def test_wrong_baseline_identity_rejected():
    baseline = collect()
    baseline['agents'][0]['coreai_agent_id'] = 'wrong'
    with pytest.raises(ValueError, match='baseline'):
        collect(baseline=baseline)


def test_duplicate_baseline_role_rejected():
    baseline = collect()
    baseline['agents'].append(dict(baseline['agents'][0]))
    with pytest.raises(ValueError, match='baseline'):
        collect(baseline=baseline)


def test_registry_never_creates_missing_db_and_is_read_only(tmp_path):
    from app.agent_catalog import read_registry
    path = tmp_path / 'db.sqlite'
    with pytest.raises(sqlite3.OperationalError):
        read_registry(path)
    assert not path.exists()
    c = sqlite3.connect(path)
    c.execute('create table seo_ops_agents (agent_key text, coreai_agent_id text, status text)')
    c.execute("insert into seo_ops_agents values ('draft','a','active')")
    c.commit()
    c.close()
    before = path.read_bytes()
    assert read_registry(path) == [{'agent_key': 'draft', 'coreai_agent_id': 'a', 'status': 'active'}]
    assert path.read_bytes() == before
