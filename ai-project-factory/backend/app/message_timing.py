"""Attach durable per-turn timings, including unambiguous legacy replies."""
from datetime import datetime


def message_timings(messages, jobs):
    result = {}
    used = set()
    for message in messages:
        if message.role != 'assistant':
            continue
        candidates = []
        for job in jobs:
            if job.id in used or job.status != 'completed' or not job.finished_at:
                continue
            proposal = job.proposal or {}
            if proposal.get('message_id') == message.id:
                candidates = [job]
                break
            if proposal.get('message_id') or proposal.get('reply') != message.content:
                continue
            # Legacy rows were inserted in the same transaction as completion.
            delta = abs((datetime.fromisoformat(message.created_at) - datetime.fromisoformat(job.finished_at)).total_seconds())
            if delta < 5 and message.created_at >= job.created_at:
                candidates.append(job)
        if len(candidates) == 1:
            job = candidates[0]
            used.add(job.id)
            result[message.id] = {'started_at': job.created_at, 'finished_at': job.finished_at}
    return result
