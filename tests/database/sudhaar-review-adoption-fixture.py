#!/usr/bin/env python3
from pathlib import Path
base=Path(__file__).resolve().parent
fixture=(base/'sudhaar-settled-outputs.test.sql').read_text()
ending="select 'Sudhaar SQL assertions: '||n from assertion_count;\nrollback;"
assert fixture.count(ending)==1
print(fixture.replace(ending,(base/'sudhaar-review-adoption.assertions.sql').read_text()+"\nrollback;"))
