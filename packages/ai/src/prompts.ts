import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

const promptCache = new Map<string, string>();

/**
 * Load a versioned prompt from `packages/ai/prompts/`.
 *
 * Memoized in-memory: prompt files are versioned and immutable once written.
 */
export function loadPrompt(name: string): string {
  const filename = name.endsWith('.md') ? name : `${name}.md`;
  const cached = promptCache.get(filename);
  if (cached !== undefined) return cached;

  const filePath = join(PROMPTS_DIR, filename);
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    promptCache.set(filename, content);
    return content;
  } catch (error) {
    throw new Error(`Failed to load prompt '${filename}' from ${filePath}: ${error}`);
  }
}
