/**
 * Public browse root for MiNERVA Archive directory listings (minerva-archive.org).
 * @type {string}
 */
export const MYRIENT_BASE_URL = 'https://minerva-archive.org/browse/';

/**
 * Identifies this app on HTTP requests (browse scrape, HEAD, GET). Keep in sync with package.json version.
 * @type {string}
 */
export const HTTP_USER_AGENT =
  'MiNERVA-Downloader/4.0.2 (+https://minerva-archive.org; desktop browse/download)';
/**
 * Defines the possible directory structures for downloaded files.
 * @readonly
 * @enum {string}
 */
export const DOWNLOAD_DIRECTORY_STRUCTURE = {
  /** No subfolders, all files in the root download directory. */
  EMPTY: 'empty',
  /** Files organized in a flat structure within subfolders based on their original path. */
  FLAT: 'flat',
  /** Files organized in subfolders mirroring their original path. */
  SUBFOLDERS: 'subfolders',
  /** A mixed structure, typically combining elements of flat and subfolders. */
  MIXED: 'mixed',
};
