/**
 * media — which binary files a viewer can draw, and how their bytes reach it.
 *
 * `git diff` says only "Binary files … differ" about an image, so the changes overlay has to
 * fetch the blobs itself to show anything. It renders in a webview with no filesystem access
 * and no HTTP server behind it, so the bytes travel inline as a `data:` URI. That is the one
 * transport both hosts can serve, which is why the shape lives here rather than beside either.
 *
 * The extension names the type from the path instead of sniffing the bytes: a preview that
 * guesses wrong on a truncated header would draw a broken image where the note used to read
 * clearly, and git already tracks these paths by extension elsewhere.
 */

/** Formats a Chromium webview draws without a decoder of its own. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/**
 * How large a blob may be before the note replaces the picture.
 *
 * A `data:` URI is base64, so it costs a third more than the file, and it crosses the bridge
 * as one string that cannot be streamed. Four mebibytes covers the icons and screenshots a
 * repository holds; a video or a design source lands well above it and is not worth stalling
 * the overlay for.
 */
export const PREVIEW_BYTE_LIMIT = 4 * 1024 * 1024;

/** The media type for a path, or null when nothing here can draw it. */
export function imageMediaType(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return IMAGE_MEDIA_TYPES[filePath.slice(dot).toLowerCase()] ?? null;
}

/** One version of an image, ready for an `<img>` element. */
export type ImageSide = {
  /** `data:<mediaType>;base64,…` — what the element's `src` is set to. */
  dataUri: string;
  /** Size of the blob itself, which the caption prints beside the picture. */
  bytes: number;
};

/**
 * Both versions of one image in a commit.
 *
 * A side is null when the commit has no such file: an addition has no `before`, a deletion no
 * `after`. Null rather than an empty string so the viewer draws one picture instead of one
 * picture and one broken element.
 */
export type ImagePreview = {
  mediaType: string;
  before: ImageSide | null;
  after: ImageSide | null;
};

export function toDataUri(mediaType: string, blob: Buffer): string {
  return `data:${mediaType};base64,${blob.toString("base64")}`;
}
