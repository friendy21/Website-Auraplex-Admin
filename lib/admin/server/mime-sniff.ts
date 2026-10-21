import type { FileTypeResult } from 'file-type';
import type { UploadContentCheck, UploadMediaRoute } from '@/lib/admin/upload-contract';
import { UploadContractError } from '@/lib/admin/upload-errors';

// file-type recommends 4,100 bytes for broad detection. Only this prefix is
// copied for inspection; the original chunks are replayed into the upload.
export const UPLOAD_SNIFF_BYTES = 4_100;

// ASF is not an accepted upload format. Reject its fixed header before the
// locked file-type v19 parser because affected v19 releases can loop forever
// on a malformed zero-size ASF sub-header (GHSA-5v7r-6r5c-r473).
const ASF_HEADER = new Uint8Array([
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
  0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
]);

/** What file-type reports for every Microsoft Compound File (DOC, XLS, PPT, but also MSI, MSG, ...). */
const COMPOUND_FILE_MIME_TYPE = 'application/x-cfb';

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

export interface SniffedUploadStream {
  stream: ReadableStream<Uint8Array>;
  /** What file-type identified; null for text, which has no signature. */
  detected: FileTypeResult | null;
}

function mismatch(message = 'File content does not match the declared media type and extension'): UploadContractError {
  return new UploadContractError(415, 'MIME_MISMATCH', message);
}

function assertDetectedMedia(
  detected: FileTypeResult | undefined,
  expectedMimeType: string,
): asserts detected is FileTypeResult {
  if (!detected) {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'File content type could not be identified',
    );
  }

  if (detected.mime !== expectedMimeType) throw mismatch();
}

/**
 * Checks for what the first bytes cannot show, on every byte as it passes.
 * `inspect` sees each chunk before it is forwarded and throws on content that
 * cannot belong to the type; `finish` runs at the end of the file and throws
 * when something the type requires was never seen. With `holdBack`, the last
 * chunk is forwarded only once `finish` has passed, so storage never receives
 * the whole of a file that fails it.
 */
interface ContentVerifier {
  holdBack: boolean;
  inspect(chunk: Uint8Array): void;
  finish(): void;
}

const NO_VERIFICATION: ContentVerifier = { holdBack: false, inspect() {}, finish() {} };

/**
 * A compound file holds one of the type's streams. Its directory, which may
 * sit anywhere in the file, stores each name as UTF-16LE with a terminating
 * NUL; the search carries the end of each chunk over to the next.
 */
function compoundFileVerifier(streams: readonly string[]): ContentVerifier {
  const names = streams.map((name) => Buffer.from(`${name}\0`, 'utf16le'));
  const overlap = Math.max(...names.map((name) => name.byteLength)) - 1;
  let tail: Buffer = Buffer.alloc(0);
  let found = false;
  return {
    holdBack: true,
    inspect(chunk) {
      if (found) return;
      const window = Buffer.concat([tail, chunk]);
      found = names.some((name) => window.includes(name));
      tail = window.subarray(Math.max(0, window.byteLength - overlap));
    },
    finish() {
      if (!found) throw mismatch();
    },
  };
}

/**
 * C0 control characters that do not occur in text files: everything below
 * 0x20 except tab, line feed, vertical tab, form feed, carriage return, SUB
 * (0x1A, the DOS end-of-file mark) and ESC. Bytes from 0x80 are allowed, so
 * UTF-8 and single-byte encodings such as Windows-1252 (Excel's default CSV)
 * both pass.
 */
const BINARY = new Uint8Array(0x20).fill(1);
for (const allowed of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1a, 0x1b]) BINARY[allowed] = 0;
const isBinary = (unit: number) => unit < 0x20 && BINARY[unit] === 1;

/**
 * No byte of the file may be binary. A UTF-16 byte-order mark (Excel's and
 * Notepad's "Unicode" text) switches the check to 16-bit code units; UTF-16
 * without one is refused, as its NUL bytes are indistinguishable from binary.
 */
function textVerifier(): ContentVerifier {
  let encoding: 'bytes' | 'utf-16le' | 'utf-16be' | null = null;
  /** The first byte while the byte-order mark is undecided, or half a UTF-16 code unit. */
  let carry: number | null = null;
  const unit = (first: number, second: number) => (encoding === 'utf-16le' ? first | (second << 8) : (first << 8) | second);
  return {
    holdBack: false,
    inspect(chunk) {
      let index = 0;
      if (encoding === null) {
        if (chunk.byteLength === 0) return;
        if (carry === null) {
          carry = chunk[0];
          index = 1;
          if (chunk.byteLength === 1) return;
        }
        const [first, second] = [carry, chunk[index]];
        encoding = first === 0xff && second === 0xfe ? 'utf-16le' : first === 0xfe && second === 0xff ? 'utf-16be' : 'bytes';
        carry = null;
        if (encoding === 'bytes') {
          if (isBinary(first)) throw mismatch('File content is not text');
        } else {
          index += 1; // The byte-order mark itself.
        }
      }
      if (encoding === 'bytes') {
        for (; index < chunk.byteLength; index += 1) {
          if (isBinary(chunk[index])) throw mismatch('File content is not text');
        }
        return;
      }
      if (carry !== null && index < chunk.byteLength) {
        if (isBinary(unit(carry, chunk[index]))) throw mismatch('File content is not text');
        carry = null;
        index += 1;
      }
      for (; index + 1 < chunk.byteLength; index += 2) {
        if (isBinary(unit(chunk[index], chunk[index + 1]))) throw mismatch('File content is not text');
      }
      if (index < chunk.byteLength) carry = chunk[index];
    },
    finish() {
      // A one-byte file, or UTF-16 with an odd number of bytes.
      if (carry !== null && (encoding !== null || isBinary(carry))) throw mismatch('File content is not text');
    },
  };
}

function contentVerifier(check: UploadContentCheck): ContentVerifier {
  if (check.kind === 'compound-file') return compoundFileVerifier(check.streams);
  if (check.kind === 'text') return textVerifier();
  return NO_VERIFICATION;
}

async function detectSignature(bytes: Uint8Array, expected: UploadMediaRoute): Promise<FileTypeResult> {
  if (startsWith(bytes, ASF_HEADER)) {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'ASF content is not an accepted upload type',
    );
  }
  // file-type v19 is ESM-only; dynamic import keeps the repository's current
  // CommonJS-compatible test runner working without changing app module mode.
  const { fileTypeFromBuffer } = await import('file-type');
  let detected: FileTypeResult | undefined;
  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'File content type could not be identified from the inspection window',
    );
  }
  assertDetectedMedia(
    detected,
    expected.content.kind === 'compound-file' ? COMPOUND_FILE_MIME_TYPE : expected.canonicalMimeType,
  );
  return detected;
}

/**
 * Reads and validates only the leading detection window, then returns a stream
 * that replays every byte (including the sniffed prefix) exactly once. Types
 * whose check needs the whole file (compound files, text) are verified as the
 * bytes pass; a failure errors the stream with MIME_MISMATCH, which aborts the
 * storage upload.
 */
export async function sniffUploadStream(
  source: ReadableStream<Uint8Array>,
  expected: UploadMediaRoute,
  sniffBytes = UPLOAD_SNIFF_BYTES,
): Promise<SniffedUploadStream> {
  const reader = source.getReader();
  const prefix = new Uint8Array(sniffBytes);
  const replayChunks: Uint8Array[] = [];
  const verifier = contentVerifier(expected.content);
  let prefixLength = 0;
  let sourceDone = false;

  try {
    while (prefixLength < sniffBytes) {
      const { done, value } = await reader.read();
      if (done) {
        sourceDone = true;
        break;
      }
      verifier.inspect(value);
      replayChunks.push(value);
      const copyLength = Math.min(value.byteLength, sniffBytes - prefixLength);
      prefix.set(value.subarray(0, copyLength), prefixLength);
      prefixLength += copyLength;
    }

    const detected = expected.content.kind === 'text'
      ? null
      : await detectSignature(prefix.subarray(0, prefixLength), expected);
    // A file that has already ended is judged now, before storage is contacted.
    if (sourceDone) verifier.finish();

    let replayIndex = 0;
    let held: Uint8Array | null = null;
    const next = async (): Promise<Uint8Array | null> => {
      if (replayIndex < replayChunks.length) return replayChunks[replayIndex++];
      const { done, value } = await reader.read();
      if (done) return null;
      verifier.inspect(value);
      return value;
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // Loops until it has enqueued or closed: a pull that does neither
          // would not be called again.
          for (;;) {
            const chunk = await next();
            if (chunk === null) {
              verifier.finish();
              if (held) controller.enqueue(held);
              controller.close();
              return;
            }
            if (!verifier.holdBack) {
              controller.enqueue(chunk);
              return;
            }
            const previous = held;
            held = chunk;
            if (previous) {
              controller.enqueue(previous);
              return;
            }
          }
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return { stream, detected };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}
