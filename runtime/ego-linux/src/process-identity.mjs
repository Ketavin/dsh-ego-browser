import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const execute = promisify(execFile);
const normalized = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

/** PID liveness alone cannot authorize reuse or termination of a stored process. */
export async function scopedBrowserStateOwnership(state, profile) {
  if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0 || state.pid === process.pid
      || typeof state.profileDir !== 'string' || typeof state.binary !== 'string' || typeof profile !== 'string') return 'unowned';
  if (normalized(state.profileDir) !== normalized(profile)) return 'unowned';
  try { process.kill(state.pid, 0); }
  catch (error) { return error?.code === 'ESRCH' ? 'absent' : 'unknown'; }
  try {
    if (normalized(await realpath(state.profileDir)) !== normalized(await realpath(profile))) return 'unowned';
    if (process.platform === 'win32') {
      const command = '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:DSH_EGO_OWNER_PID); '
        + "$flag='(?i)(?:^|\\s)\"?--user-data-dir=(?:\"'+[regex]::Escape($env:DSH_EGO_OWNER_PROFILE)+'\"|'+[regex]::Escape($env:DSH_EGO_OWNER_PROFILE)+')\"?(?:\\s|$)'; "
        + 'if($p -and $p.ExecutablePath -eq $env:DSH_EGO_OWNER_BINARY -and $p.CommandLine -match $flag){"owned"}else{"unowned"}';
      const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...process.env, DSH_EGO_OWNER_PID: String(state.pid), DSH_EGO_OWNER_PROFILE: profile, DSH_EGO_OWNER_BINARY: resolve(state.binary) },
        windowsHide: true, timeout: 5000, maxBuffer: 1024,
      });
      return result.stdout.trim() === 'owned' ? 'owned' : 'unowned';
    }
    if (process.platform === 'linux') {
      const args = (await readFile(`/proc/${state.pid}/cmdline`, 'utf8')).split('\0');
      return normalized(await realpath(`/proc/${state.pid}/exe`)) === normalized(await realpath(state.binary))
        && args.includes(`--user-data-dir=${profile}`) ? 'owned' : 'unowned';
    }
    return 'unknown';
  } catch { return 'unknown'; }
}
