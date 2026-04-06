import fs from 'fs';
import path from 'path';
import https from 'https';
import { URL } from 'url';
import axios from 'axios';
import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import MyrientService from './MyrientService.js';
import FileSystemService from './FileSystemService.js';
import { HTTP_USER_AGENT } from '../../shared/constants/appConstants.js';

/**
 * Service responsible for gathering information about files to be downloaded.
 * This includes checking file sizes, and determining if files have been previously downloaded or extracted.
 * @class
 */
class DownloadInfoService {
  _isRomMetadataUrl(fileUrl) {
    try {
      const u = new URL(fileUrl);
      return u.pathname.replace(/\/$/, '') === '/rom' && !!u.searchParams.get('name');
    } catch {
      return false;
    }
  }

  async _getHashesDb(session, origin) {
    if (!this.hashDbByOrigin.has(origin)) {
      const loadPromise = (async () => {
        const response = await session.get(`${origin}/assets/hashes.db`, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const dbBytes = new Uint8Array(response.data);
        const SQL = await this.sqlInitPromise;
        return new SQL.Database(dbBytes);
      })();
      this.hashDbByOrigin.set(origin, loadPromise);
    }
    return this.hashDbByOrigin.get(origin);
  }

  async _resolveRomMetadataUrl(session, fileUrl) {
    const parsed = new URL(fileUrl);
    const slug = parsed.searchParams.get('name');
    if (!slug) return null;
    try {
      const db = await this._getHashesDb(session, parsed.origin);
      const stmt = db.prepare('SELECT torrents FROM files WHERE full_path = ? LIMIT 1');
      stmt.bind([slug]);
      let torrentPath = null;
      if (stmt.step()) {
        const row = stmt.getAsObject();
        torrentPath = typeof row.torrents === 'string' ? row.torrents : null;
      }
      stmt.free();
      if (!torrentPath) return null;
      const href = new URL(`/assets/${torrentPath.replace(/^\/+/, '')}`, parsed.origin).href;
      const name = decodeURIComponent(torrentPath.split('/').filter(Boolean).pop() || '');
      return { href, name: name || null };
    } catch {
      return null;
    }
  }

  /**
   * Best-effort remote size fetch. Falls back from HEAD to ranged GET.
   * @param {import('axios').AxiosInstance} session
   * @param {string} fileUrl
   * @returns {Promise<number>}
   * @private
   */
  async _getRemoteSize(session, fileUrl) {
    try {
      const headRes = await session.head(fileUrl, { timeout: 15000 });
      const size = parseInt(headRes.headers['content-length'] || '0', 10);
      if (Number.isFinite(size) && size > 0) return size;
    } catch (e) {
      // Fall through to GET range probe.
    }

    try {
      const probeRes = await session.get(fileUrl, {
        timeout: 15000,
        responseType: 'stream',
        headers: { Range: 'bytes=0-0' }
      });

      const contentRange = probeRes.headers['content-range'];
      if (typeof contentRange === 'string') {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
      }
      const size = parseInt(probeRes.headers['content-length'] || '0', 10);
      if (Number.isFinite(size) && size > 0) return size;
    } catch (e) {
      // Return unknown size.
    }

    return 0;
  }

  /**
   * Creates an instance of DownloadInfoService.
   * @param {MyrientService} myrientService An instance of MyrientService.
   */
  constructor(myrientService) {
    this.httpAgent = new https.Agent({ keepAlive: true });
    this.abortController = new AbortController();
    this.myrientService = myrientService;
    const require = createRequire(import.meta.url);
    this.sqlInitPromise = initSqlJs({
      locateFile: (file) => {
        if (file === 'sql-wasm.wasm') return require.resolve('sql.js/dist/sql-wasm.wasm');
        return file;
      }
    });
    this.hashDbByOrigin = new Map();
  }

  /**
   * Cancels any ongoing download information retrieval processes.
   * @memberof DownloadInfoService
   */
  cancel() {
    this.abortController.abort();
  }

  /**
   * Checks if the download information retrieval process has been cancelled.
   * @memberof DownloadInfoService
   * @returns {boolean} True if cancelled, false otherwise.
   */
  isCancelled() {
    return this.abortController.signal.aborted;
  }

  /**
   * Resets the AbortController, allowing for new operations to be started.
   * @memberof DownloadInfoService
   */
  reset() {
    this.abortController = new AbortController();
    this.httpAgent = new https.Agent({ keepAlive: true });
  }

  /**
   * Recursively fetches all file links within a given directory URL and its subdirectories.
   * @memberof DownloadInfoService
   * @param {string} directoryUrl The URL of the directory to scan.
   * @param {string} [currentRelativePath=''] The current relative path from the initial selected directory.
   * @returns {Promise<Array<{name: string, href: string, type: string, relativePath: string}>>} A flattened array of file objects found within the directory and its subdirectories.
   * @private
   */
  async _recursivelyGetFilesInDirectory(directoryUrl, currentRelativePath = '') {
    let allFiles = [];
    const html = await this.myrientService.getPage(directoryUrl);
    const links = this.myrientService.parseLinks(html, directoryUrl);

    for (const link of links) {
      if (this.isCancelled()) throw new Error("CANCELLED_SCAN");

      const fullUrl = new URL(link.href, directoryUrl).href;
      if (link.isDir) {
        allFiles = allFiles.concat(await this._recursivelyGetFilesInDirectory(fullUrl, path.join(currentRelativePath, link.name)));
      } else {
        allFiles.push({ name: link.name, href: fullUrl, type: 'file', relativePath: path.join(currentRelativePath, link.name) });
      }
    }
    return allFiles;
  }

  /**
   * Gathers download information for a list of files and/or directories, including total size,
   * and identifies files that can be skipped due to prior download or extraction.
   * @memberof DownloadInfoService
   * @param {Electron.BrowserWindow} win The Electron BrowserWindow instance for sending progress updates.
   * @param {string} baseUrl The base URL for the items.
   * @param {Array<object>} items An array of file and/or directory objects, each with at least `name_raw`, `href`, and `type`.
   * @param {string} targetDir The target directory for downloads.
   * @param {boolean} [createSubfolder=false] Whether to create a subfolder for each download.
   * @param {boolean} [maintainFolderStructure=false] Whether to maintain the site's folder structure.
   * @returns {Promise<object>} An object containing:
   *   - `filesToDownload`: Array of file objects that need to be downloaded.
   *   - `totalSize`: Total size of all files (including skipped ones).
   *   - `skippedSize`: Total size of skipped files.
   *   - `skippedFiles`: Array of file objects that were skipped.
   *   - `skippedBecauseExtractedCount`: Number of files skipped because they were already extracted.
   *   - `skippedBecauseDownloadedCount`: Number of files skipped because they were already downloaded.
   * @throws {Error} If the scan is cancelled.
   */
  async getDownloadInfo(win, baseUrl, items, targetDir, createSubfolder = false, maintainFolderStructure = false) {
    let totalSize = 0;
    let skippedSize = 0;
    const filesToDownload = [];
    const skippedFiles = [];
    let skippedBecauseExtractedCount = 0;
    let skippedBecauseDownloadedCount = 0;

    const allFilesToProcess = [];
    for (const item of items) {
      if (item.type === 'directory') {
        const directoryUrl = new URL(item.href, baseUrl).href;
        const filesInDir = await this._recursivelyGetFilesInDirectory(directoryUrl, item.name_raw);
        allFilesToProcess.push(...filesInDir);
      } else {
        allFilesToProcess.push({ name: item.name_raw, href: new URL(item.href, baseUrl).href, type: 'file', relativePath: item.name_raw });
      }
    }

    const session = axios.create({
      httpsAgent: this.httpAgent,
      timeout: 15000,
      headers: {
        'User-Agent': HTTP_USER_AGENT,
      },
      signal: this.abortController.signal
    });

    for (let i = 0; i < allFilesToProcess.length; i++) {
      if (this.isCancelled()) throw new Error("CANCELLED_SCAN");

      const fileInfo = allFilesToProcess[i];
      let filename = fileInfo.name;
      let fileUrl = fileInfo.href;

      if (this._isRomMetadataUrl(fileUrl)) {
        const resolved = await this._resolveRomMetadataUrl(session, fileUrl);
        if (resolved?.href) {
          fileUrl = resolved.href;
          fileInfo.href = resolved.href;
          if (resolved.name) {
            filename = resolved.name;
            fileInfo.name = resolved.name;
          }
        }
      }

      const { targetPath, extractPath } = FileSystemService.calculatePaths(targetDir, fileInfo, { createSubfolder, maintainFolderStructure, baseUrl });
      const partPath = `${targetPath}.part`;

      if (await FileSystemService.isAlreadyExtracted(extractPath, filename)) {
        fileInfo.skip = true;
        fileInfo.skippedBecauseExtracted = true;
        skippedBecauseExtractedCount++;
        const remoteSize = await this._getRemoteSize(session, fileUrl);
        fileInfo.size = remoteSize;
        totalSize += remoteSize;
        skippedSize += remoteSize;
        skippedFiles.push(fileInfo);
        win.webContents.send('download-scan-progress', { current: i + 1, total: allFilesToProcess.length });
        continue;
      }

      try {
        const remoteSize = await this._getRemoteSize(session, fileUrl);

        fileInfo.size = remoteSize;
        totalSize += remoteSize;

        if (fs.existsSync(targetPath)) {
          const localSize = fs.statSync(targetPath).size;
          if (remoteSize > 0 && localSize === remoteSize) {
            fileInfo.skip = true;
            fileInfo.skippedBecauseDownloaded = true;
            fileInfo.path = targetPath;
            skippedBecauseDownloadedCount++;
            skippedSize += remoteSize;
            skippedFiles.push(fileInfo);
          } else if (remoteSize > 0 && localSize < remoteSize) {
            fileInfo.skip = false;
            fileInfo.downloadedBytes = localSize;
            skippedSize += localSize;
            filesToDownload.push(fileInfo);
          } else {
            fileInfo.skip = false;
            filesToDownload.push(fileInfo);
          }
        } else if (fs.existsSync(partPath)) {
          const localSize = fs.statSync(partPath).size;
          if (remoteSize > 0 && localSize < remoteSize) {
            fileInfo.skip = false;
            fileInfo.downloadedBytes = localSize;
            skippedSize += localSize;
            filesToDownload.push(fileInfo);
          } else if (remoteSize > 0 && localSize >= remoteSize) {
            try {
              if (localSize === remoteSize) {
                fs.renameSync(partPath, targetPath);
                fileInfo.skip = true;
                fileInfo.skippedBecauseDownloaded = true;
                fileInfo.path = targetPath;
                skippedBecauseDownloadedCount++;
                skippedSize += remoteSize;
                skippedFiles.push(fileInfo);
              } else {
                // Part file size does not match what the server reports.
                // Delete it so the downloader re-downloads from scratch.
                fs.unlinkSync(partPath);
                fileInfo.skip = false;
                fileInfo.downloadedBytes = 0;
                filesToDownload.push(fileInfo);
              }
            } catch (renameErr) {
              fileInfo.skip = false;
              filesToDownload.push(fileInfo);
            }
          } else {
            fileInfo.skip = false;
            filesToDownload.push(fileInfo);
          }
        } else {
          fileInfo.skip = false;
          filesToDownload.push(fileInfo);
        }
      } catch (e) {
        // Keep file in queue even if scan metadata fails; downloader can still attempt transfer.
        fileInfo.size = Number.isFinite(fileInfo.size) ? fileInfo.size : 0;
        fileInfo.skip = false;
        filesToDownload.push(fileInfo);
      }
      win.webContents.send('download-scan-progress', { current: i + 1, total: allFilesToProcess.length });
    }

    return { filesToDownload, totalSize, skippedSize, skippedFiles, skippedBecauseExtractedCount, skippedBecauseDownloadedCount };
  }
}

export default DownloadInfoService;