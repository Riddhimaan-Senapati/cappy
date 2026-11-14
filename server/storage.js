import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const directory = process.env.BROWSER_AGENT_DATA_DIR || join(homedir(), '.config', 'browser-agent');
const filename = join(directory, 'credentials.json');

export async function loadState() {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [], activeId: null };
  }
}

export async function saveState(state) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, filename);
}
