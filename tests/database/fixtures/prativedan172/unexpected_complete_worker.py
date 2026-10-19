"""Owned adversarial fixture: unexpected complete frame and detached descendant."""
import json
import os
import sys
import time
if os.getuid()!=20006 or os.getgroups():
    raise SystemExit(2)
if not sys.stdin.buffer.readline(4194305):
    raise SystemExit(2)
pid=os.fork()
if pid==0:
    os.setsid()
    while True:
        time.sleep(1)
sys.stdout.write(json.dumps({'kind':'complete','request':{'model':'forbidden-fixture','prompt':'synthetic-no-egress'}})+'\n')
sys.stdout.flush()
