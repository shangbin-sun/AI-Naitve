"""Content-free timing events, correlated by job id and bounded on disk."""
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import time

current_trace = ContextVar('chat_performance_trace', default=None)


class PerformanceLog:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self.handler = RotatingFileHandler(directory / 'chat-performance.jsonl', maxBytes=5_000_000, backupCount=3, encoding='utf-8', delay=True)
        self.handler.setFormatter(logging.Formatter('%(message)s'))

    def emit(self, job_id, event, **fields):
        payload = {'at': datetime.now(timezone.utc).isoformat(), 'job_id': job_id, 'event': event, **fields}
        record = logging.LogRecord('chat.performance', logging.INFO, '', 0, json.dumps(payload, ensure_ascii=False), (), None)
        # Diagnostics must not turn a successful generation into a failed job.
        try:
            self.handler.handle(record)
        except OSError:
            pass

    def close(self):
        self.handler.close()


class Trace:
    def __init__(self, sink, identity):
        self.sink, self.identity = sink, identity
        self.started = time.perf_counter()
        self.marks = {}
        self.counts = {}

    def mark(self, event, **fields):
        elapsed = round((time.perf_counter() - self.started) * 1000, 3)
        self.marks[event] = elapsed
        if self.sink:
            self.sink.emit(self.identity, event, elapsed_ms=elapsed, **fields)

    def once(self, event, **fields):
        if event not in self.marks:
            self.mark(event, **fields)

    def add(self, name, value=1):
        self.counts[name] = self.counts.get(name, 0) + value

    def finish(self, status):
        self.mark('job_finished', status=status, stages_ms=self.marks.copy(), counters=self.counts)
        first = self.marks.get('first_reply_text')
        if self.sink and (first is not None and first > 10_000 or status not in ('completed', 'cancelled')):
            self.sink.emit(self.identity, 'latency_alert', status=status,
                           first_reply_ms=first, total_ms=self.marks['job_finished'])


def mark(event, **fields):
    trace = current_trace.get()
    if trace:
        trace.mark(event, **fields)


def once(event, **fields):
    trace = current_trace.get()
    if trace:
        trace.once(event, **fields)


def add(name, value=1):
    trace = current_trace.get()
    if trace:
        trace.add(name, value)
