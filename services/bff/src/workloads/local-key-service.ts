import { constants } from 'node:fs';
import { open, lstat, realpath, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DispatchRefused } from './dispatch-payload.js';
import { dispatchKmsBinding } from './dispatch-key-policy.js';
import { LocalKeyPolicy, type LocalKeyCaller, type LocalKeyAdmission } from './local-key-policy.js';

/** Unmounted key-service primitive. Master keys never leave this process.
 * Directory provisioning, durable admission verification and peer authentication
 * belong to the operator composition; this module supplies none implicitly. */
export class LocalKeyService {
  constructor(
    private readonly directory: string,
    private readonly policy: LocalKeyPolicy,
    private readonly admission?: LocalKeyAdmission,
  ) {}

  private async directoryGate() {
    if (
      !process.getuid ||
      this.directory !== resolve(this.directory) ||
      (await realpath(this.directory)) !== this.directory
    )
      throw new DispatchRefused();
    const uid = process.getuid();
    for (let path = this.directory; ; path = dirname(path)) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        ![0, uid].includes(stat.uid) ||
        (path === this.directory
          ? stat.uid !== uid || (stat.mode & 0o7777) !== 0o700
          : (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
      )
        throw new DispatchRefused();
      if (path === dirname(path)) break;
    }
  }
  private filename(ref: string) {
    return join(this.directory, createHash('sha256').update(ref).digest('hex') + '.key');
  }
  private async key(ref: string) {
    await this.directoryGate();
    const file = await open(this.filename(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid!() ||
        (info.mode & 0o7777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size !== 32
      )
        throw new DispatchRefused();
      const key = Buffer.alloc(32);
      if ((await file.read(key, 0, 32, 0)).bytesRead !== 32) {
        key.fill(0);
        throw new DispatchRefused();
      }
      return key;
    } finally {
      await file.close();
    }
  }
  async provision(
    caller: LocalKeyCaller,
    keyRef: string,
    deadline = Date.now() + 5000,
  ): Promise<void> {
    const bound = Object.freeze({ ...caller });
    let secret: Buffer | undefined;
    let temporary: string | undefined;
    try {
      await this.policy.require(bound, 'provision', keyRef, deadline, this.admission);
      await this.directoryGate();
      secret = randomBytes(32);
      temporary = join(this.directory, '.pending-' + randomBytes(16).toString('hex'));
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(secret);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.policy.require(bound, 'provision', keyRef, deadline, this.admission);
      // Atomic no-replace publication: a key version can never be overwritten.
      await link(temporary, this.filename(keyRef));
      await unlink(temporary);
      temporary = undefined;
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new DispatchRefused();
    } finally {
      secret?.fill(0);
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
  async wrap(
    caller: LocalKeyCaller,
    context: Uint8Array,
    plaintext: Uint8Array,
    deadline = Date.now() + 5000,
  ): Promise<{ keyRef: string; wrappedKey: Uint8Array }> {
    const bound = Object.freeze({ ...caller });
    let master: Buffer | undefined, clear: Buffer | undefined;
    try {
      if (!(context instanceof Uint8Array) || context.byteLength > 4096)
        throw new DispatchRefused();
      const binding = dispatchKmsBinding(Buffer.from(context)),
        ref = this.policy.value.primary;
      if (
        binding.tenant !== bound.tenantId ||
        !(plaintext instanceof Uint8Array) ||
        plaintext.byteLength !== 32
      )
        throw new DispatchRefused();
      clear = Buffer.from(plaintext);
      await this.policy.require(bound, 'wrap', ref, deadline, this.admission);
      master = await this.key(ref);
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', master, nonce);
      cipher.setAAD(binding.aad);
      const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
      const wrappedKey = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
      await this.policy.require(bound, 'wrap', ref, deadline, this.admission);
      return { keyRef: ref, wrappedKey };
    } catch {
      throw new DispatchRefused();
    } finally {
      master?.fill(0);
      clear?.fill(0);
    }
  }
  async unwrap(
    caller: LocalKeyCaller,
    context: Uint8Array,
    keyRef: string,
    wrapped: Uint8Array,
    deadline = Date.now() + 5000,
  ): Promise<Uint8Array> {
    const bound = Object.freeze({ ...caller });
    let master: Buffer | undefined, clear: Buffer | undefined;
    try {
      if (!(context instanceof Uint8Array) || context.byteLength > 4096)
        throw new DispatchRefused();
      if (!(wrapped instanceof Uint8Array) || wrapped.byteLength !== 61)
        throw new DispatchRefused();
      const binding = dispatchKmsBinding(Buffer.from(context)),
        bytes = Buffer.from(wrapped);
      if (binding.tenant !== bound.tenantId || bytes.length !== 61 || bytes[0] !== 1)
        throw new DispatchRefused();
      await this.policy.require(bound, 'unwrap', keyRef, deadline, this.admission);
      master = await this.key(keyRef);
      const cipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(1, 13));
      cipher.setAAD(binding.aad);
      cipher.setAuthTag(bytes.subarray(13, 29));
      clear = Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]);
      await this.policy.require(bound, 'unwrap', keyRef, deadline, this.admission);
      return Buffer.from(clear);
    } catch {
      throw new DispatchRefused();
    } finally {
      master?.fill(0);
      clear?.fill(0);
    }
  }
}
