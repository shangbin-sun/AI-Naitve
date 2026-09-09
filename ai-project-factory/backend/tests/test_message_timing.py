from types import SimpleNamespace as Row
from app.message_timing import message_timings


def test_each_reply_keeps_own_timing_and_legacy_matching():
    messages = [Row(id='m1', role='assistant', content='same', created_at='2026-09-09T08:00:04+00:00'), Row(id='m2', role='assistant', content='same', created_at='2026-09-09T08:01:35+00:00')]
    jobs = [Row(id='j1', status='completed', created_at='2026-09-09T08:00:00+00:00', finished_at=messages[0].created_at, proposal={'reply': 'same'}), Row(id='j2', status='completed', created_at='2026-09-09T08:01:00+00:00', finished_at=messages[1].created_at, proposal={'reply': 'same', 'message_id': 'm2'})]
    result = message_timings(messages, jobs)
    assert result['m1']['started_at'] == jobs[0].created_at
    assert result['m2']['started_at'] == jobs[1].created_at
    jobs[0].proposal = {'reply': 'different'}
    assert 'm1' not in message_timings(messages, jobs)
