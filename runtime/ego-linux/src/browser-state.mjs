import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** The durable owner record is authoritative; browser.json is a disposable mirror. */
export function createBrowserStateStore({ stateFile, ownerFile, scoped }) {
  return {
    async read() {
      if (scoped) {
        let text;
        try { text = await readFile(ownerFile, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('runtime-owner-record-unverified'); }
        if (text !== undefined) {
          try {
            const value = JSON.parse(text);
            if (value.version !== 1 || !value.state || typeof value.state !== 'object' || Array.isArray(value.state)) throw new Error();
            return value.state;
          } catch { throw new Error('runtime-owner-record-unverified'); }
        }
      }
      // Compatibility with an already running browser from remote.8 or earlier.
      try { return JSON.parse(await readFile(stateFile, 'utf8')); }
      catch { return null; }
    },
    async write(state) {
      // A crash between these writes must preserve the NEW owner's identity.
      if (scoped) await atomicJson(ownerFile, { version: 1, state });
      await atomicJson(stateFile, state);
    },
    async forget() {
      // Call only after the existing PID AND endpoint checks prove quiescence.
      await rm(stateFile, { force: true });
      if (scoped) await rm(ownerFile, { force: true });
    },
  };
}
