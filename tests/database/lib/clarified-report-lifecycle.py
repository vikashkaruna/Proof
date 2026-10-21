"""Emit isolated0180 lifecycle SQL using reviewed real assessment fixture prefixes.

Pure source assembly; no database, network, Auth, account or provider operations.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def program(root: Path = ROOT) -> str:
    suite = (root / 'tests/database/clarified-report-lifecycle.test.sql').read_text()
    questionnaire = (root / 'tests/database/branded-board-lifecycle.test.sql').read_text()
    marker = 'reset role; -- privileged fixture'
    if questionnaire.count(marker) != 1:
        raise ValueError('Reviewed questionnaire fixture boundary changed')
    questionnaire = questionnaire.split(marker)[0]
    public = (root / 'tests/database/public-control-asset-report-provenance.test.sql').read_text()
    marker = 'create temporary table board_requested as '
    if public.count(marker) != 1:
        raise ValueError('Reviewed finalized public fixture boundary changed')
    public = public.split(marker)[0]
    contexts = [
        (questionnaire, "select '99750000-0000-4000-8000-000000000010'::uuid t,'99750000-0000-4000-8000-000000000001'::uuid manager,'99750000-0000-4000-8000-000000000002'::uuid founder,'99750000-0000-4000-8000-000000000030'::uuid eng,(select run_id from board_issued)run,false is_public"),
        (public, "select pg_temp.id(31)t,pg_temp.id(3)manager,pg_temp.id(1)founder,pg_temp.id(41)eng,((select value from issued)->>'run_id')::uuid run,true is_public"),
    ]
    return '\n'.join(prefix + '\nreset role;\ncreate temporary table clarified180_context as ' + context + ';\n' + suite for prefix, context in contexts)


if __name__ == '__main__':
    print(program())
