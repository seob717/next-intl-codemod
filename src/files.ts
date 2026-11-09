import fs from 'node:fs';
import path from 'node:path';

// next-intl's extractor scans exactly these; a message in any other file would be dropped from the catalogs.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out']);

/** Source files that mention one of the old hooks; everything else cannot change. */
export function collectSourceFiles(dir: string, out: Array<string> = []): Array<string> {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collectSourceFiles(path.join(dir, entry.name), out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      const file = path.join(dir, entry.name);
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('useTranslations') || text.includes('getTranslations')) out.push(file);
    }
  }
  return out;
}
