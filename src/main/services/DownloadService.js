import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import { Throttle } from '@kldzj/stream-throttle';
import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import FileSystemService from './FileSystemService.js';
import { HTTP_USER_AGENT, MINERVA_TORRENT_CDN_BASE_URL } from '../../shared/constants/appConstants.js';

/**
 * Service responsible for handling the actual downloading of files,
 * including managing progress updates, cancellation, resuming downloads,
 * throttling, and error handling during the download process.
 * @class
 * @property {boolean} downloadCancelled - Flag to indicate if the current download operation has been cancelled.
 * @property {https.Agent} httpAgent - An HTTP agent configured for keep-alive connections.
 * @property {AbortController} abortController - An AbortController instance for signal-based cancellation of requests.
 * @property {ConsoleService} downloadConsole - An instance of ConsoleService for logging download-related messages.
 */
class DownloadService {
  _getTorrentCandidates(origin, torrentPath) {
    if (!torrentPath || typeof torrentPath !== 'string') return [];
    const normalized = torrentPath.trim();
    if (!normalized) return [];

    const candidates = [];
    const pushCandidate = (url) => {
      if (!url || candidates.includes(url)) return;
      candidates.push(url);
    };

    if (/^https?:\/\//i.test(normalized)) {
      pushCandidate(normalized);
      return candidates;
    }

    if (normalized.startsWith('/assets/')) {
      pushCandidate(new URL(normalized, origin).href);
    }

    const cleaned = normalized.replace(/^\/+/, '');
    pushCandidate(new URL(`/assets/${cleaned}`, origin).href);
    pushCandidate(new URL(cleaned, MINERVA_TORRENT_CDN_BASE_URL).href);
    const justName = cleaned.split('/').filter(Boolean).pop();
    if (justName) {
      pushCandidate(new URL(justName, MINERVA_TORRENT_CDN_BASE_URL).href);
    }

    return candidates;
  }

  async _pickReachableTorrentUrl(session, candidates) {
    for (const candidate of candidates) {
      try {
        const response = await session.head(candidate, {
          timeout: 8000,
          validateStatus: () => true,
        });
        if (response.status >= 200 && response.status < 400) return candidate;
      } catch (e) {}
    }
    return candidates[0] || null;
  }

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
    const origin = parsed.origin;
    const slug = parsed.searchParams.get('name');
    if (!slug) return null;

    try {
      const db = await this._getHashesDb(session, origin);
      const stmt = db.prepare('SELECT torrents, size FROM files WHERE full_path = ? LIMIT 1');
      stmt.bind([slug]);
      let torrentPath = null;
      let payloadSize = 0;
      if (stmt.step()) {
        const row = stmt.getAsObject();
        torrentPath = typeof row.torrents === 'string' ? row.torrents : null;
        const parsedSize = parseInt(String(row.size ?? '0'), 10);
        payloadSize = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0;
      }
      stmt.free();
      if (!torrentPath) return null;

      const candidates = this._getTorrentCandidates(origin, torrentPath);
      const resolved = await this._pickReachableTorrentUrl(session, candidates);
      if (!resolved) return null;
      const suggestedName = decodeURIComponent((new URL(resolved)).pathname.split('/').filter(Boolean).pop() || '');
      return {
        href: resolved,
        name: suggestedName || null,
        payloadSize,
      };
    } catch (e) {}

    // Fallback for schema/content drift: try to resolve from /rom metadata response directly.
    try {
      const response = await session.get(fileUrl, {
        responseType: 'text',
        timeout: 30000,
        headers: {
          'Accept': 'application/json,text/plain,text/html,*/*',
        },
      });
      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
      const extractedTorrentPath = (() => {
        const jsonTorrentsMatch = body.match(/"torrents"\s*:\s*"([^"]+\.torrent[^"]*)"/i);
        if (jsonTorrentsMatch?.[1]) return jsonTorrentsMatch[1];

        const assetsPathMatch = body.match(/\/assets\/[^"'`\s<>]+\.torrent\b/i);
        if (assetsPathMatch?.[0]) return assetsPathMatch[0];

        return null;
      })();
      if (!extractedTorrentPath) return null;

      const candidates = this._getTorrentCandidates(origin, extractedTorrentPath);
      const resolved = await this._pickReachableTorrentUrl(session, candidates);
      if (!resolved) return null;
      const suggestedName = decodeURIComponent((new URL(resolved)).pathname.split('/').filter(Boolean).pop() || '');
      return {
        href: resolved,
        name: suggestedName || null,
        payloadSize: 0,
      };
    } catch (fallbackErr) {
      return null;
    }
  }

  _formatDownloadError(error, fileUrl) {
    if (!error) return `Unknown error for ${fileUrl}`;
    const status = error?.response?.status;
    const statusText = error?.response?.statusText;
    const msg = error?.message || String(error);
    if (status) {
      return `${msg} (status ${status}${statusText ? ` ${statusText}` : ''}, url ${fileUrl})`;
    }
    return `${msg} (url ${fileUrl})`;
  }

  _getExpectedFinalSize(fileSize, response) {
    // Prefer the GET response headers over scan-time HEAD sizes,
    // since HEAD might be missing/incorrect for some endpoints.
    const expectedFromResponse = (() => {
      if (!response) return 0;
      const contentRange = response?.headers?.['content-range'];
      if (typeof contentRange === 'string') {
        const totalMatch = contentRange.match(/\/(\d+)$/);
        if (totalMatch) {
          const parsedTotal = parseInt(totalMatch[1], 10);
          if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
            return parsedTotal;
          }
        }
      }
      const contentLength = parseInt(response?.headers?.['content-length'] || '0', 10);
      return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    })();

    if (expectedFromResponse > 0) return expectedFromResponse;

    if (Number.isFinite(fileSize) && fileSize > 0) return fileSize;

    const contentRange = response?.headers?.['content-range'];
    if (typeof contentRange === 'string') {
      const totalMatch = contentRange.match(/\/(\d+)$/);
      if (totalMatch) {
        const parsedTotal = parseInt(totalMatch[1], 10);
        if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
          return parsedTotal;
        }
      }
    }
    const contentLength = parseInt(response?.headers?.['content-length'] || '0', 10);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  }

  /**
   * Creates an instance of DownloadService.
   * @param {ConsoleService} downloadConsole An instance of ConsoleService for logging.
   */
  constructor(downloadConsole) {
    this.downloadCancelled = false;
    this.httpAgent = new https.Agent({ keepAlive: true });
    this.abortController = new AbortController();
    this.downloadConsole = downloadConsole;
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
   * Cancels any ongoing download operations by setting the cancellation flag and aborting the current AbortController signal.
   * @memberof DownloadService
   */
  cancel() {
    this.downloadCancelled = true;
    this.abortController.abort();
  }

  /**
   * Checks if the current download operation has been cancelled.
   * @memberof DownloadService
   * @returns {boolean} True if the download has been cancelled, false otherwise.
   */
  isCancelled() {
    return this.downloadCancelled;
  }

  /**
   * Resets the download service's state, allowing for new download operations.
   * This involves resetting the cancellation flag and creating a new AbortController instance.
   * @memberof DownloadService
   */
  reset() {
    this.downloadCancelled = false;
    this.abortController = new AbortController();
  }

  /**
   * Downloads a list of files sequentially, providing progress updates.
   * This method handles file creation, partial downloads (resuming), throttling, and error recovery for individual files.
   *
   * @memberof DownloadService
   * @param {Electron.BrowserWindow} win The Electron BrowserWindow instance, used to send progress updates to the renderer process.
   * @param {string} baseUrl The base URL from which the files are to be downloaded.
   * @param {Array<object>} files An array of file objects to download. Each object should contain:
   *   - `name` (string): The filename.
   *   - `href` (string): The full URL of the file.
   *   - `size` (number): The total size of the file in bytes.
   *   - `downloadedBytes` (number, optional): The number of bytes already downloaded for this specific file, for resuming.
   *   - `skip` (boolean, optional): If true, this file will be skipped.
   * @param {string} targetDir The absolute path to the directory where the files will be saved.
   * @param {number} totalSize The total expected size of all files combined (in bytes), used for overall progress calculation.
   * @param {number} [initialDownloadedSize=0] The cumulative size of files that were already downloaded or skipped before starting this batch (in bytes).
   * @param {boolean} [createSubfolder=false] If true, each file will be downloaded into a subfolder named after the file's base name within `targetDir`.
   * @param {boolean} [maintainFolderStructure=false] If true, the remote folder structure indicated by `file.href` and `baseUrl` will be recreated within `targetDir`.
   * @param {number} totalFilesOverall The total number of files originally selected for download, including those skipped or already processed.
   * @param {number} initialSkippedFileCount The number of files that were skipped from the beginning due to various reasons (e.g., already exists).
   * @param {boolean} [isThrottlingEnabled=false] If true, limits the download speed to `throttleSpeed`.
   * @param {number} [throttleSpeed=10] The speed limit for throttling in the given `throttleUnit`.
   * @param {'KB/s'|'MB/s'} [throttleUnit='MB/s'] The unit for `throttleSpeed`.
   * @returns {Promise<{skippedFiles: Array<string>, downloadedFiles: Array<object>}>} A promise that resolves with an object containing:
   *   - `skippedFiles` (Array<string>): An array of filenames that could not be downloaded due to errors.
   *   - `downloadedFiles` (Array<{name: string, href: string, size: number, path: string}>): An array of file objects that were successfully downloaded, including their final saved path.
   * @throws {Error} If the download is explicitly cancelled by the user, either between files ("CANCELLED_BETWEEN_FILES") or during a file transfer ("CANCELLED_MID_FILE").
   *   Other errors during the download of a specific file will be caught and added to `skippedFiles`.
   */
  async downloadFiles(win, baseUrl, files, targetDir, totalSize, initialDownloadedSize = 0, createSubfolder = false, maintainFolderStructure = false, totalFilesOverall, initialSkippedFileCount, isThrottlingEnabled = false, throttleSpeed = 10, throttleUnit = 'MB/s') {
    const session = axios.create({
      httpsAgent: this.httpAgent,
      timeout: 15000,
      headers: {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    session.interceptors.request.use((config) => {
      try {
        const requestUrl = new URL(config.url);
        config.headers = {
          ...(config.headers || {}),
          'Referer': `${requestUrl.origin}/`,
          'Origin': requestUrl.origin,
        };
      } catch (e) {}
      return config;
    });

    let totalDownloaded = initialDownloadedSize;
    let totalBytesFailed = 0;
    const skippedFiles = [];
    const downloadedFiles = [];
    let lastDownloadProgressUpdateTime = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const fileInfo = files[fileIndex];
      if (this.isCancelled()) {
        throw new Error("CANCELLED_BETWEEN_FILES");
      }

      if (fileInfo.skip) continue;

      let filename = fileInfo.name;
      let fileUrl = fileInfo.href;

      if (this._isRomMetadataUrl(fileUrl)) {
        const resolved = await this._resolveRomMetadataUrl(session, fileUrl);
        if (resolved?.href) {
          fileUrl = resolved.href;
          if (resolved.name) {
            filename = resolved.name;
            fileInfo.name = resolved.name;
          }
          if (resolved.payloadSize > 0) {
            fileInfo.payloadSize = resolved.payloadSize;
          }
          this.downloadConsole.log(`Resolved ROM metadata URL to asset URL for ${filename}`);
        } else {
          throw new Error(`Could not resolve ROM metadata URL to downloadable asset for ${filename}`);
        }
      }

      const { targetPath } = FileSystemService.calculatePaths(targetDir, fileInfo, { createSubfolder, maintainFolderStructure, baseUrl });
      const partPath = `${targetPath}.part`;

      const finalDir = path.dirname(targetPath);
      if (!fs.existsSync(finalDir)) {
        try {
          fs.mkdirSync(finalDir, { recursive: true });
        } catch (mkdirErr) {
          this.downloadConsole.logCreatingSubfolderError(finalDir, mkdirErr.message);
        }
      }

      const fileSize = fileInfo.size || 0;
      let fileDownloaded = fileInfo.downloadedBytes || 0;
      let bytesDownloadedThisAttempt = 0;

      // If a previous run left incomplete bytes as the final filename (not as `.part`),
      // move it aside so we can correctly resume without losing the initial bytes.
      if (fileDownloaded > 0 && fs.existsSync(targetPath) && !fs.existsSync(partPath)) {
        try {
          fs.renameSync(targetPath, partPath);
        } catch (e) {
          // If rename fails, we'll fall back to writing a fresh `.part` below.
        }
      }

      const headers = {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': 'application/octet-stream,*/*;q=0.8',
      };

      if (fileDownloaded > 0) {
        headers['Range'] = `bytes=${fileDownloaded}-`;
        this.downloadConsole.logResumingDownload(filename, fileDownloaded);
      }

      try {
        const response = await session.get(fileUrl, {
          responseType: 'stream',
          timeout: 30000,
          signal: this.abortController.signal,
          headers: headers
        });

        if (response.status !== 200 && response.status !== 206) {
          throw new Error(`Bad response status ${response.status} for ${filename}`);
        }

        const contentType = response?.headers?.['content-type'] || '';
        if (contentType.includes('text/html')) {
          throw new Error(`Unexpected HTML response for ${filename}; likely error page.`);
        }

        // Some servers ignore Range requests and return the full file with HTTP 200.
        // If that happens, restart this file from scratch to avoid appending duplicate bytes.
        if (fileDownloaded > 0 && response.status !== 206) {
          this.downloadConsole.log(`Range not honored for ${filename}; restarting from byte 0.`);
          fileDownloaded = 0;
        }

        const expectedFinalSizeForProgress = this._getExpectedFinalSize(fileSize, response);

        const writer = fs.createWriteStream(partPath, {
          highWaterMark: 1024 * 1024,
          flags: fileDownloaded > 0 && response.status === 206 ? 'a' : 'w'
        });

        win.webContents.send('download-file-progress', {
          name: filename,
          current: fileDownloaded,
          total: fileSize,
          currentFileIndex: initialSkippedFileCount + fileIndex + 1,
          totalFilesToDownload: totalFilesOverall
        });

        let stream = response.data;
        if (isThrottlingEnabled) {
          let bytesPerSecond = throttleSpeed * 1024;
          if (throttleUnit === 'MB/s') {
            bytesPerSecond = throttleSpeed * 1024 * 1024;
          }
          const throttle = new Throttle({ rate: bytesPerSecond });
          response.data.on('error', err => throttle.emit('error', err));
          stream = response.data.pipe(throttle);
        }

        await new Promise((resolve, reject) => {
          const cleanupAndReject = (errMessage) => {
            writer.close(() => {
              fs.unlink(partPath, (unlinkErr) => {
                if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                  console.error(`Failed to delete partial file: ${partPath}`, unlinkErr);
                }
                const err = new Error(errMessage);
                err.partialFile = { path: partPath, name: filename };
                reject(err);
              });
            });
          };

          stream.on('data', (chunk) => {
            fileDownloaded += chunk.length;
            bytesDownloadedThisAttempt += chunk.length;
            totalDownloaded += chunk.length;

            const now = performance.now();
            const currentExpected = expectedFinalSizeForProgress > 0 ? expectedFinalSizeForProgress : fileSize;
            if (now - lastDownloadProgressUpdateTime > 100 || (currentExpected > 0 && fileDownloaded === currentExpected)) {
              lastDownloadProgressUpdateTime = now;
              win.webContents.send('download-file-progress', {
                name: filename,
                current: fileDownloaded,
                total: currentExpected,
                currentFileIndex: initialSkippedFileCount + fileIndex + 1,
                totalFilesToDownload: totalFilesOverall
              });
              win.webContents.send('download-overall-progress', {
                current: totalDownloaded,
                total: totalSize - totalBytesFailed,
                skippedSize: initialDownloadedSize,
                isFinal: false
              });
            }
          });

          writer.on('finish', () => {
            let finalSize = 0;
            try {
              finalSize = fs.statSync(partPath).size;
            } catch (statErr) {
              return reject(statErr);
            }

            const expectedFinalSize = expectedFinalSizeForProgress;
            if (expectedFinalSize > 0 && finalSize !== expectedFinalSize) {
              const sizeError = new Error(`SIZE_MISMATCH: expected ${expectedFinalSize} bytes, got ${finalSize} bytes`);
              try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e2) {}
              return reject(sizeError);
            }

            // Lightweight corruption check: ZIP archives should start with the "PK" signature.
            // This catches cases where the server returns an error HTML page but we still get a small 200/OK.
            if (filename.toLowerCase().endsWith('.zip')) {
              try {
                const fd = fs.openSync(partPath, 'r');
                const buf = Buffer.alloc(2);
                fs.readSync(fd, buf, 0, 2, 0);
                fs.closeSync(fd);
                const sig = buf.toString('utf8');
                if (sig !== 'PK') {
                  const sigError = new Error(`BAD_ZIP_SIGNATURE: expected PK for ${filename}`);
                  try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e2) {}
                  return reject(sigError);
                }
              } catch (sigErr) {
                try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e2) {}
                return reject(sigErr);
              }
            }

            // Ensure we can overwrite the final target (especially after a failed/partial previous run).
            try {
              if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
            } catch (unlinkErr) {}

            fs.rename(partPath, targetPath, (err) => {
              if (err) {
                return reject(err);
              }
              win.webContents.send('download-file-progress', {
                  name: filename,
                  current: finalSize,
                  total: expectedFinalSize || finalSize,
                  currentFileIndex: initialSkippedFileCount + fileIndex + 1,
                  totalFilesToDownload: totalFilesOverall
              });
              downloadedFiles.push({ ...fileInfo, path: targetPath });
              resolve();
            });
          });

          writer.on('error', (err) => {
            reject(err);
          });

          stream.on('error', (err) => {
            if (err.name === 'CanceledError' || this.isCancelled()) {
              cleanupAndReject("CANCELLED_MID_FILE");
            } else {
              reject(err);
            }
          });

          stream.pipe(writer);
        });

      } catch (e) {
        if (e.name === 'AbortError' || e.message.startsWith("CANCELLED_")) {
          throw e;
        }

        this.downloadConsole.logError(`Failed to download ${filename}. Error: ${this._formatDownloadError(e, fileUrl)}`);
        skippedFiles.push(filename);

        totalDownloaded -= bytesDownloadedThisAttempt;
        totalBytesFailed += fileSize;

        win.webContents.send('download-overall-progress', {
          current: totalDownloaded,
          total: totalSize - totalBytesFailed,
          skippedSize: initialDownloadedSize,
          isFinal: false
        });

        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
        } catch (fsErr) {
        }
      }
    }

    return { skippedFiles, downloadedFiles };
  }
}

export default DownloadService;
