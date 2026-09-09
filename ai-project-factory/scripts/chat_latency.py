"""Summarize recent content-free chat timing logs; does not invoke a model."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import statistics


def summarize(directory, limit=20):
    events = []
    for path in sorted(directory.glob('chat-performance.jsonl*'), reverse=True):
        for line in path.read_text(encoding='utf-8').splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    by_job = defaultdict(dict)
    for event in events:
        by_job[event['job_id']][event['event']] = event
    rows = []
    for identity, group in by_job.items():
        summary = group.get('job_finished')
        if not summary:
            continue
        stages = summary.get('stages_ms', {})
        first = stages.get('first_reply_text')
        runtime = group.get('runtime_started', {})
        usage = group.get('turn_completed', {}).get('usage', {})
        rows.append({'job_id': identity, 'at': summary['at'], 'status': summary['status'],
                     'model': next((group[event].get('actual_model') for event in ('thread_ready', 'thread_resumed', 'thread_reused') if event in group), None),
                     'mode': runtime.get('mode', 'legacy'),
                     'schema_bytes': group.get('turn_sent', {}).get('schema_bytes'),
                     'effort': runtime.get('effort'), 'lean_context': runtime.get('lean_context'),
                     'first_reply_seconds': round(first/1000, 3) if first is not None else None,
                     'total_seconds': round(summary['elapsed_ms']/1000, 3),
                     'input_tokens': usage.get('input_tokens'), 'cached_tokens': usage.get('cached_input_tokens'),
                     'reply_db_writes': summary.get('counters', {}).get('reply_db_writes', 0)})
    rows = sorted(rows, key=lambda row: row['at'])[-limit:]
    values = [row['first_reply_seconds'] for row in rows if row['status'] == 'completed' and row['first_reply_seconds'] is not None]
    return {'samples': len(rows), 'completed_with_reply': len(values),
            'median_first_reply_seconds': round(statistics.median(values), 3) if values else None,
            'slow_first_replies_over_10s': sum(value > 10 for value in values),
            'failed_or_interrupted': sum(row['status'] not in ('completed', 'cancelled') for row in rows),
            'jobs': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[1]/'.data')
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error('--limit must be positive')
    print(json.dumps(summarize(args.data_dir, args.limit), ensure_ascii=False, indent=2))
