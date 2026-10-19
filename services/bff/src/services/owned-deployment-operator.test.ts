import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedDeploymentOperatorAuth } from './owned-deployment-operator.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'axiom-owned-operator-')));
  directories.push(dir);
  await chmod(dir, 0o700);
  const filename = join(dir, 'transport.private.json');
  const value = 'existing-operator-transport-fixture-only-' + '.'.repeat(30);
  await writeFile(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'owned_synthetic_installer_transport',
      existingOperatorAccessToken: value,
    }),
    { mode: 0o600 },
  );
  return {
    filename,
    value,
    headers: new Headers({ 'X-Axiom-Local-Operator': value }),
    auth: new OwnedDeploymentOperatorAuth(filename, true),
  };
}
it('authenticates exact existing protected transport credential only when explicitly enabled', async () => {
  const f = await fixture();
  await expect(f.auth.authenticate(f.headers)).resolves.toBeUndefined();
  await expect(new OwnedDeploymentOperatorAuth(f.filename).authenticate(f.headers)).rejects.toThrow(
    'Owned deployment operator authentication refused',
  );
});
it.each(['Origin', 'Referer', 'Sec-Fetch-Site', 'Cookie', 'Authorization'])(
  'refuses browser/proxy authority header %s',
  async (header) => {
    const f = await fixture();
    f.headers.set(header, 'untrusted');
    await expect(f.auth.authenticate(f.headers)).rejects.toThrow(
      'Owned deployment operator authentication refused',
    );
  },
);
it('rejects missing/wrong token and decoded service role claims as authority', async () => {
  const f = await fixture();
  for (const value of [
    '',
    f.value.slice(0, -1) + 'x',
    Buffer.from('{"role":"service_role"}').toString('base64url') + '.' + f.value,
  ]) {
    await expect(
      f.auth.authenticate(new Headers({ 'X-Axiom-Local-Operator': value })),
    ).rejects.toThrow('Owned deployment operator authentication refused');
  }
});
it('refuses writable transport files and never prints private values in errors', async () => {
  const f = await fixture();
  await chmod(f.filename, 0o644);
  try {
    await f.auth.authenticate(f.headers);
    throw Error('unexpected success');
  } catch (error) {
    expect(String(error)).toBe('Error: Owned deployment operator authentication refused');
    expect(String(error)).not.toContain(f.value);
    expect(String(error)).not.toContain(f.filename);
  }
});
