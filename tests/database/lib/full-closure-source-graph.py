"""Compose real existing SQL workflow fixtures into one rolled-back closure graph.

All provider receipts are explicitly synthetic fixture ports; this executes no
SQL itself and never contacts retained infrastructure or a real provider.
"""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
auditor = (root / 'questionnaire-evidence-auditor-lifecycle.test.sql').read_text()
print(auditor.replace('rollback;', ''))
board = (root / 'questionnaire-evidence-lifecycle.test.sql').read_text()
start = board.index('do $$\ndeclare')
board = board[start:board.index('end $$;', start) + len('end $$;')]
board = board.replace('99750000', '99880000').replace('board_issued', 'statutory_issued').replace('board-test-lib','statutory-test-lib').replace('BOARD-001','AUDITOR-001')
board = board.replace(" perform pg_temp.ok(not exists(select 1 from public.reports where tenant_id=t),'refused drafts wrote nothing');", '')
print(board)
# Preserve genuine token, dry-run, verification, signed reconciliation and
# independent proof review/release RPCs. Only initial fixture scope is shared.
approval = (root / 'approval-proof-archive.test.sql').read_text().replace('begin;\n','',1).replace('rollback;', '')
a = approval.index('insert into public.tenants(')
b = approval.index('insert into public.remediation_plans(', a)
approval = approval[:a] + "insert into public.tenant_users(tenant_id,user_id,role) values('99880000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','founder');\n" + approval[b:]
approval = approval.replace('10000000-0000-4000-8000-000000000010','99880000-0000-4000-8000-000000000010').replace('10000000-0000-4000-8000-000000000020','99880000-0000-4000-8000-000000000030').replace("'archive-test'", "'statutory-test-lib'")
approval = approval.replace("insert into public.approval_tokens(", "update public.remediation_actions set closes_finding_ids=(select array_agg(id order by id) from public.findings where tenant_id='99880000-0000-4000-8000-000000000010' and engagement_id='99880000-0000-4000-8000-000000000030') where id='10000000-0000-4000-8000-000000000040';\ninsert into public.approval_tokens(",1)
print(approval)
print("update public.remediation_actions set approval_token_id='10000000-0000-4000-8000-000000000060', approved_by='10000000-0000-4000-8000-000000000002', approval_status='approved', rollback_validated_at=clock_timestamp(), dry_run_completed_at=clock_timestamp(), dry_run_expires_at=clock_timestamp()+interval '1 hour' where id='10000000-0000-4000-8000-000000000040';")
print("update public.remediation_plans set status='completed' where id='10000000-0000-4000-8000-000000000030';")
technical = (root / 'technical-source-bound.test.sql').read_text()
start = technical.index('do $$\ndeclare')
technical = technical[start:technical.index('end $$;', start) + len('end $$;')]
technical = technical.replace('99430000-0000-4000-8000-000000000060','10000000-0000-4000-8000-000000000030').replace('99430000','99880000')
technical = technical.replace("'valid recorded plan request'", "'valid recorded plan request: '||x::text")
print(technical)
