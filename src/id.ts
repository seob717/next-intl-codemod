import {createHash} from 'node:crypto';

/** Mirrors `packages/swc-plugin-extractor/src/key_generator.rs`. */
export function generateId(message: string): string {
  return createHash('sha512').update(message, 'utf8').digest('base64url').slice(0, 6);
}
