"""Backfill stored delivery evidence using the platform's employee archive exporter."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.config import Settings
from app.models import Evaluation
from app.output_workspace import prepare_outputs

if __name__ == '__main__':
    settings = Settings.from_env()
    count = 0
    with Session(create_engine(settings.database_url)) as db:
        for run in db.scalars(select(Evaluation).where(Evaluation.kind == 'delivery')):
            if run.status in ('queued', 'running'):
                continue
            prepare_outputs(settings.data_dir / 'output-workspaces', run)
            count += 1
    print(f'已按员工归档 {count} 次运行，保留已有工作副本。')
