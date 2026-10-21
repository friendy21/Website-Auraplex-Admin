import type { BusinessLine } from '@/lib/admin/upload-domain';

export type UploadStatus =
  | 'pending'
  | 'processed'
  | 'failed'
  | 'unsupported';

export type UiUploadQueueStatus = 'ready' | 'uploading' | 'uploaded' | 'failed' | 'unsupported';

// Optional build-time UI ceiling only. The server-enforced cap comes from
// ADMIN_UPLOAD_MAX_MB at request time and is passed to the admin page.
const configuredClientUploadMb = Number(process.env.NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB);
export const CLIENT_UPLOAD_MAX_MB = Number.isSafeInteger(configuredClientUploadMb) && configuredClientUploadMb > 0
  ? configuredClientUploadMb
  : null;

export function effectiveClientUploadMaxMb(serverMaxMb: number): number {
  return CLIENT_UPLOAD_MAX_MB === null ? serverMaxMb : Math.min(CLIENT_UPLOAD_MAX_MB, serverMaxMb);
}

export const UPLOAD_HEADERS = {
  filename: 'x-upload-filename',
  productLine: 'x-product-line',
  productId: 'x-product-id',
  csrfToken: 'x-csrf-token',
} as const;

export interface UploadRequestMetadata {
  businessLine: BusinessLine;
  productId: string;
  originalFilename: string;
  declaredMimeType: string;
  /** Present only when the request carried Content-Length. */
  declaredSize?: number;
  csrfToken: string;
}

export interface UploadSuccessResponse {
  ok: true;
  uploadId: string;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  /** Bytes actually received and stored. */
  size: number;
  status: UploadStatus;
}

export interface RecentUpload {
  uploadId: string;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  filename: string;
  size: number;
  uploadedAt: string | null;
  ingestionCapability: UploadMediaRoute['ingestionCapability'];
  status: UploadStatus;
}

export interface DeleteUploadResponse {
  ok: true;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export interface RecentUploadsResponse {
  ok: true;
  uploads: RecentUpload[];
  qdrantAvailable: boolean;
}

export type UploadApiErrorCode =
  | 'MALFORMED_REQUEST'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_CONTENT_LENGTH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MIME_MISMATCH'
  | 'INVALID_FILENAME'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_LINE_MISMATCH'
  | 'MISSING_CSRF_TOKEN'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPLOAD_CAPACITY_EXHAUSTED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'IDENTITY_PROVIDER_UNAVAILABLE'
  | 'PARTIAL_DELETE'
  | 'INTERNAL_ERROR';

export type UploadApiErrorStatus =
  | 400
  | 408
  | 401
  | 403
  | 413
  | 415
  | 429
  | 500
  | 503;

export const UPLOAD_ERROR_STATUS = {
  MALFORMED_REQUEST: 400,
  REQUEST_TIMEOUT: 408,
  INVALID_CONTENT_LENGTH: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  SIZE_MISMATCH: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  MIME_MISMATCH: 415,
  INVALID_FILENAME: 400,
  INVALID_PRODUCT: 400,
  PRODUCT_LINE_MISMATCH: 400,
  MISSING_CSRF_TOKEN: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  UPLOAD_CAPACITY_EXHAUSTED: 503,
  BACKEND_NOT_CONFIGURED: 503,
  IDENTITY_PROVIDER_UNAVAILABLE: 503,
  PARTIAL_DELETE: 500,
  INTERNAL_ERROR: 500,
} as const satisfies Record<UploadApiErrorCode, UploadApiErrorStatus>;

export interface UploadApiErrorResponse {
  ok: false;
  code: UploadApiErrorCode;
  error: string;
}

export type UploadApiResponse = UploadSuccessResponse | UploadApiErrorResponse;

export interface UploadObjectLocation {
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export type UploadBucket =
  | 'auraplex-raw-pdf'
  | 'auraplex-raw-docs'
  | 'auraplex-raw-image'
  | 'auraplex-raw-video';

export const UPLOAD_BUCKETS: readonly UploadBucket[] = [
  'auraplex-raw-pdf',
  'auraplex-raw-docs',
  'auraplex-raw-image',
  'auraplex-raw-video',
];

/**
 * How the server confirms that the content is the declared type
 * (lib/admin/server/mime-sniff.ts):
 *
 * - `signature`: file-type identifies exactly `canonicalMimeType` from the
 *   first bytes.
 * - `compound-file`: a Microsoft Compound File, the container of the Office
 *   97-2003 formats, recognised from its first bytes, that holds one of
 *   `streams` (looked for anywhere in the file). This is what tells a Word,
 *   Excel and PowerPoint file apart.
 * - `text`: plain text has no signature; no byte of the file may be binary.
 */
export type UploadContentCheck =
  | { kind: 'signature' }
  | { kind: 'compound-file'; streams: readonly string[] }
  | { kind: 'text' };

export interface UploadMediaRoute {
  bucket: UploadBucket;
  /** Buckets this type was stored in before; objects there stay listed and deletable. */
  legacyBuckets?: readonly UploadBucket[];
  canonicalMimeType: string;
  acceptedExtensions: readonly string[];
  ingestionCapability: 'supported' | 'deferred';
  content: UploadContentCheck;
}

const SIGNATURE = { kind: 'signature' } as const;
const TEXT = { kind: 'text' } as const;

export const UPLOAD_MEDIA_ROUTES: Readonly<Record<string, UploadMediaRoute>> = {
  'application/pdf': {
    bucket: 'auraplex-raw-pdf',
    canonicalMimeType: 'application/pdf',
    acceptedExtensions: ['pdf'],
    ingestionCapability: 'supported',
    content: SIGNATURE,
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    bucket: 'auraplex-raw-docs',
    // Stored with the PDFs until documents got their own bucket.
    legacyBuckets: ['auraplex-raw-pdf'],
    canonicalMimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedExtensions: ['docx'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    acceptedExtensions: ['xlsx'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    acceptedExtensions: ['pptx'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
  'application/msword': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'application/msword',
    acceptedExtensions: ['doc'],
    ingestionCapability: 'deferred',
    content: { kind: 'compound-file', streams: ['WordDocument'] },
  },
  'application/vnd.ms-excel': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'application/vnd.ms-excel',
    acceptedExtensions: ['xls'],
    ingestionCapability: 'deferred',
    // `Book` is the Excel 5.0/95 name of the workbook stream; some writers
    // use upper case (the same names Apache POI accepts).
    content: { kind: 'compound-file', streams: ['Workbook', 'WORKBOOK', 'Book', 'BOOK'] },
  },
  'application/vnd.ms-powerpoint': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'application/vnd.ms-powerpoint',
    acceptedExtensions: ['ppt'],
    ingestionCapability: 'deferred',
    content: { kind: 'compound-file', streams: ['PowerPoint Document'] },
  },
  'text/csv': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'text/csv',
    acceptedExtensions: ['csv'],
    ingestionCapability: 'deferred',
    content: TEXT,
  },
  'text/plain': {
    bucket: 'auraplex-raw-docs',
    canonicalMimeType: 'text/plain',
    acceptedExtensions: ['txt'],
    ingestionCapability: 'deferred',
    content: TEXT,
  },
  'image/png': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/png',
    acceptedExtensions: ['png'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
  'image/jpeg': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/jpeg',
    acceptedExtensions: ['jpg', 'jpeg'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
  'video/mp4': {
    bucket: 'auraplex-raw-video',
    canonicalMimeType: 'video/mp4',
    acceptedExtensions: ['mp4'],
    ingestionCapability: 'deferred',
    content: SIGNATURE,
  },
};

/** Whether objects of this type belong in `bucket`: its own, or one it was stored in before. */
export function uploadMediaStoredIn(route: UploadMediaRoute, bucket: string): boolean {
  return route.bucket === bucket || (route.legacyBuckets ?? []).includes(bucket as UploadBucket);
}

export const ACCEPTED_UPLOAD_EXTENSIONS = Object.freeze(
  Array.from(
    new Set(
      Object.values(UPLOAD_MEDIA_ROUTES).flatMap(
        (route) => route.acceptedExtensions,
      ),
    ),
  ),
);

/**
 * react-dropzone `accept` map, derived from the same routes the server
 * enforces. It filters the file picker only; the server remains authoritative.
 */
export const UPLOAD_DROPZONE_ACCEPT: Readonly<Record<string, string[]>> = Object.freeze(
  Object.fromEntries(
    Object.values(UPLOAD_MEDIA_ROUTES).map((route) => [
      route.canonicalMimeType,
      route.acceptedExtensions.map((extension) => `.${extension}`),
    ]),
  ),
);

export function uploadMediaForExtension(
  extension: string,
): UploadMediaRoute | undefined {
  const normalized = extension.toLowerCase();
  return Object.values(UPLOAD_MEDIA_ROUTES).find((route) =>
    route.acceptedExtensions.includes(normalized),
  );
}
