"""Read-only configuration observations; never dispatches or changes bindings."""

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from .config import configured_agent_slots
from .coreai import CoreAiClient, CoreAiError


SCHEMA = 'seo_ops.agent_catalog.v1'
CONFIG_FIELDS = (
    'system_prompt', 'system_prompt_id', 'model', 'multi_modal_model',
    'prefer_caption_path', 'temperature', 'thinking_effort', 'max_turns',
    'timeout_seconds', 'tools', 'input_template', 'variables', 'enable_memory',
    'type', 'response_schema', 'subagent_ids', 'skill_ids', 'sandbox_config',
    'dataset_config', 'status',
)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def read_registry(path):
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(
            'SELECT agent_key,coreai_agent_id,status FROM seo_ops_agents ORDER BY agent_key')]
    finally:
        conn.close()


def skill_ids(agent):
    ids = agent.get('skill_ids') or []
    expanded = agent.get('skills') or []
    if not isinstance(ids, list) or not isinstance(expanded, list):
        raise ValueError('invalid skill declarations')
    result = set()
    for value in ids + [s.get('id') if isinstance(s, dict) else None for s in expanded]:
        if not isinstance(value, str) or not value.strip():
            raise ValueError('invalid skill declarations')
        result.add(value)
    return sorted(result)


def collect_catalog(client, registry, settings, baseline=None):
    slots = {s.agent_key: s.coreai_agent_id for s in configured_agent_slots(settings)}
    rows = {r['agent_key']: dict(r) for r in registry}
    if len(rows) != len(registry):
        raise ValueError('duplicate registry roles')
    for key, aid in slots.items():
        rows.setdefault(key, {'agent_key': key, 'coreai_agent_id': aid, 'status': None})
    identity = {k: r['coreai_agent_id'] for k, r in rows.items()}
    old_agents, old_skills = {}, {}
    if baseline is not None:
        if (not isinstance(baseline, dict) or baseline.get('schema_version') != SCHEMA
                or not isinstance(baseline.get('agents'), list)
                or not isinstance(baseline.get('skills'), list)):
            raise ValueError('invalid baseline')
        old_agents = {a['agent_key']: a for a in baseline['agents']}
        if len(old_agents) != len(baseline['agents']):
            raise ValueError('duplicate baseline roles')
        if {k: a['coreai_agent_id'] for k, a in old_agents.items()} != identity:
            raise ValueError('baseline identity mismatch')
        old_skills = {s['id']: s for s in baseline['skills']}

    coverage = {'complete': False, 'visible_count': 0, 'reported_total': None,
                'scope': 'current-account direct declarations only'}
    references = {}
    try:
        listing = client._request('GET', '/api/agents')
        items, total = listing.get('agents'), listing.get('total')
        if (not isinstance(items, list) or type(total) is not int or total < 0
                or any(not isinstance(a, dict) or not isinstance(a.get('id'), str)
                       or not a['id'] for a in items)):
            raise ValueError('invalid list')
        unique = {a['id'] for a in items}
        if len(unique) != len(items) or total < len(items):
            raise ValueError('invalid list')
        for a in items:
            for sid in skill_ids(a):
                references.setdefault(sid, set()).add(a['id'])
        coverage.update(complete=len(unique) == total, visible_count=len(unique),
                        reported_total=total)
    except (CoreAiError, ValueError, TypeError):
        references = {}
        coverage['error'] = 'AGENT_LIST_UNAVAILABLE'

    agents, dependencies = [], set()
    for key, r in sorted(rows.items()):
        aid = r['coreai_agent_id']
        item = dict(r, configured_id=slots.get(key), binding_state=(
            'configuration_only' if r['status'] is None else
            'registry_only' if key not in slots else
            'matches' if slots[key] == aid else 'mismatch'), change='unknown')
        try:
            a = client.get_agent(aid)
            deps = skill_ids(a)
            digest = fingerprint({**{f: a.get(f) for f in CONFIG_FIELDS},
                                  'declared_skill_ids': deps})
            previous = old_agents.get(key, {}).get('config_digest')
            item.update(remote_status=a.get('status'), skill_ids=deps, config_digest=digest,
                        change=('not_compared' if previous is None else
                                'unchanged' if previous == digest else 'changed'))
            dependencies.update(deps)
        except (CoreAiError, ValueError, TypeError):
            item['error'] = 'AGENT_READ_FAILED'
        agents.append(item)

    for key in ('COREAI_KEYWORD_SEED_SKILL_ID', 'COREAI_KEYWORD_RANKING_SKILL_ID'):
        if settings.get(key):
            dependencies.add(settings[key].strip())
    skills = []
    for sid in sorted(dependencies):
        item = {'id': sid, 'visible_agent_ids': sorted(references.get(sid, [])),
                'shared_observed': len(references.get(sid, [])) > 1, 'change': 'unknown'}
        try:
            # Quote explicitly; existing get_skill accepts a raw path component.
            s = client._request('GET', '/api/skills/' + quote(sid, safe=''))
            if s.get('id') != sid or not isinstance(s.get('qualified_name'), str):
                raise ValueError('skill identity mismatch')
            digest = s.get('digest')
            if not isinstance(digest, str) or not digest:
                raise ValueError('skill digest unavailable')
            previous = old_skills.get(sid, {}).get('digest')
            item.update(qualified_name=s['qualified_name'], digest=digest,
                        change=('not_compared' if previous is None else
                                'unchanged' if previous == digest else 'changed'))
        except (CoreAiError, ValueError, TypeError):
            item['error'] = 'SKILL_READ_FAILED'
        skills.append(item)
    return {'schema_version': SCHEMA, 'observed_at': datetime.now(timezone.utc).isoformat(),
            'coverage': coverage, 'agents': agents, 'skills': skills,
            'limitations': ['No ownership inference', 'No dynamic skill discovery',
                            'Not a runtime or historical task-binding audit']}


def main(argv=None):
    from dotenv import dotenv_values
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--baseline')
    args = parser.parse_args(argv)
    client = None
    try:
        settings = dotenv_values(args.env_file)
        url, token = settings.get('COREAI_BASE_URL'), settings.get('COREAI_API_KEY')
        if not url or not token:
            raise ValueError('missing configuration')
        source = fingerprint(url.rstrip('/'))
        baseline = json.loads(Path(args.baseline).read_text()) if args.baseline else None
        if baseline is not None and (not isinstance(baseline, dict)
                                     or baseline.get('source_fingerprint') != source):
            raise ValueError('baseline source mismatch')
        client = CoreAiClient(url, token, timeout=15)
        result = collect_catalog(client, read_registry(args.db), settings, baseline)
        result['source_fingerprint'] = source
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if (not result['coverage']['complete'] or any(
            x.get('error') or x.get('binding_state') == 'mismatch'
            for x in result['agents'] + result['skills'])) else 0
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, CoreAiError):
        print('{"error":"CATALOG_CHECK_FAILED"}', file=sys.stderr)
        return 2
    finally:
        if client is not None:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
