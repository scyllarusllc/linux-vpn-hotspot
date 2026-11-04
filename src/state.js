// Small persistent state in ~/.config/wifi-extender/state.json (the folder keeps the
// project's original name, so existing setups keep their settings), e.g.
// { proxyEnabled: true, uplink: "wlp0s20f0u2" }. Updates merge into what is there.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wifi-extender');
const file = join(configDir, 'state.json');

export async function loadState() {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

export async function updateState(patch) {
  const next = { ...(await loadState()), ...patch };
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
