import type { BootstrapDocumentEncoding } from '@headroom/shared';

const TEXT_EXTENSIONS = ['.md', '.txt'];

/** Real text formats round-trip safely as a UTF-8 string; anything else the New Project upload
 *  accepts (`.pdf`, `.doc`, `.docx`) is binary and must be base64-encoded instead, or forcing it
 *  through a plain UTF-8 string would corrupt it before it ever reaches the daemon. */
export function documentEncodingForFilename(filename: string): BootstrapDocumentEncoding {
  const lower = filename.toLowerCase();
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? 'utf8' : 'base64';
}
