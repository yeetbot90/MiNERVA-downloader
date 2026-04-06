import DownloadInfoService from './DownloadInfoService.js';
import DownloadService from './DownloadService.js';
import { open } from 'yauzl-promise';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { formatBytes, parseSize } from '../../shared/utils/formatters.js';
import { calculateEta } from '../../shared/utils/time.js';
import { URL } from 'url';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { MINERVA_IDS_RAW_BASE_URL } from '../../shared/constants/appConstants.js';

/**
 * Manages the overall download and extraction process.
 * Orchestrates DownloadInfoService and DownloadService.
 * @class
 */
class DownloadManager {
  static TORRENT_PAYLOAD_STALL_TIMEOUT_MS = 120000;
  static LOCAL_MINERVA_IDS_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../vendor/minerva-archive-ids/markdown-files'
  );

  _normalizeForMatch(value) {
    let normalized = String(value || '')
      .replace(/^.*[\\/]/, '')
      .replace(/[?#].*$/, '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\[[^\]]*]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .toLowerCase()
      .trim();

    // Strip common split/archive suffixes (e.g. .zip.001, .7z.010, .part01) and
    // then remove a trailing extension chain to avoid hard-coding every ROM/file type.
    normalized = normalized
      .replace(/\.(?:part\d{1,3}|z\d{2,3}|\d{3,4})$/i, '')
      .replace(/\.[a-z][a-z0-9+_-]{0,15}(?:\.[a-z0-9][a-z0-9+_-]{0,15})?$/i, '');

    return normalized
      .replace(/[_\-.]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _loadIdsMarkdownForTorrent(torrentName) {
    const fileName = `${torrentName}-ids.md`;
    const localPath = path.join(DownloadManager.LOCAL_MINERVA_IDS_DIR, fileName);
    try {
      const localContents = await fs.promises.readFile(localPath, 'utf8');
      if (typeof localContents === 'string' && localContents.trim()) {
        return localContents;
      }
    } catch {
      // Local vendored map not found; continue with remote fallback.
    }

    const encodedFileName = encodeURIComponent(fileName).replace(/%2F/g, '/');
    const baseCandidates = [
      MINERVA_IDS_RAW_BASE_URL,
      'https://raw.githubusercontent.com/Caprico1/Minerva-archive-ids/main/markdown-files/',
    ];

    for (const baseUrl of baseCandidates) {
      const url = `${baseUrl}${encodedFileName}`;
      const response = await axios.get(url, {
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/plain,*/*;q=0.8',
        },
      });
      if (response.status >= 200 && response.status < 400 && typeof response.data === 'string') {
        return response.data;
      }
    }

    return null;
  }

  _parseMarkdownIdRows(markdownText) {
    const results = [];
    if (!markdownText || typeof markdownText !== 'string') return results;
    for (const line of markdownText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || /^#/.test(trimmed)) continue;
      if (/^\|\s*:?-{2,}:?\s*\|/.test(trimmed)) continue; // markdown table separator row

      // table style: | 123 | Game Name |
      // Also supports extra pipes in file names by only splitting first "id" column.
      let match = null;
      if (trimmed.startsWith('|')) {
        const cols = trimmed.split('|');
        if (cols.length >= 3) {
          const idText = (cols[1] || '').trim();
          const nameText = cols.slice(2).join('|').replace(/\|\s*$/, '').trim();
          if (/^\d+$/.test(idText) && nameText) {
            match = [trimmed, idText, nameText];
          }
        }
      }
      if (!match) {
        // list style: 123 - Game Name
        match = trimmed.match(/^(\d+)\s*[-:|]\s*(.+)$/);
      }
      if (!match) {
        // ordered list style: 123. Game Name
        match = trimmed.match(/^(\d+)\.\s+(.+)$/);
      }
      if (!match) {
        // bullet + id style: - 123 - Game Name
        match = trimmed.match(/^[-*]\s*(\d+)\s*[-:|]\s*(.+)$/);
      }
      if (!match) {
        // csv style: 123,Game Name
        match = trimmed.match(/^(\d+)\s*,\s*(.+)$/);
      }
      if (!match) {
        // markdown link style: [123](link) - Game Name OR [123](link)|Game Name
        match = trimmed.match(/^\[\s*(\d+)\s*]\([^)]*\)\s*[-:|]\s*(.+)$/);
      }
      if (!match) continue;

      const id = parseInt(match[1], 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      const fileName = match[2]
        .trim()
        .replace(/^`|`$/g, '')
        .replace(/^\[|\]$/g, '')
        .replace(/^"+|"+$/g, '')
        .replace(/^\*+|\*+$/g, '')
        .replace(/^_+|_+$/g, '')
        .trim();
      if (!fileName) continue;
      results.push({ id, fileName });
    }
    return results;
  }

  async _resolveTorrentFileIdsForGame(torrentFileName, requestedGameName) {
    if (!torrentFileName || !requestedGameName) return [];
    const markdown = await this._loadIdsMarkdownForTorrent(torrentFileName);
    if (!markdown) return [];
    const parsedRows = this._parseMarkdownIdRows(markdown);
    if (parsedRows.length === 0) return [];

    const target = this._normalizeForMatch(requestedGameName);
    const exactIds = parsedRows
      .filter((row) => this._normalizeForMatch(path.basename(row.fileName)) === target)
      .map((row) => row.id);
    if (exactIds.length > 0) return exactIds;

    return parsedRows
      .filter((row) => this._normalizeForMatch(path.basename(row.fileName)).includes(target))
      .map((row) => row.id);
  }

  _applyFileSelection(torrent, selectedFileIds) {
    const selectedIds = new Set(selectedFileIds.filter((id) => Number.isFinite(id) && id > 0));
    if (selectedIds.size === 0) return 0;

    if (typeof torrent.deselect === 'function' && Number.isFinite(torrent.pieces?.length) && torrent.pieces.length > 0) {
      torrent.deselect(0, torrent.pieces.length - 1, false);
    }

    let selectedCount = 0;
    torrent.files.forEach((f, idx) => {
      const id = idx + 1;
      if (selectedIds.has(id)) {
        f.select();
        selectedCount += 1;
      } else {
        f.deselect();
      }
    });
    return selectedCount;
  }

  _buildAria2Args(torrentPath, destination, selectedIds = []) {
    const args = [
      '--seed-time=0',
      '--file-allocation=none',
      '--check-integrity=false',
      '--bt-save-metadata=true',
      '--follow-torrent=mem',
      '--summary-interval=1',
      '--enable-color=false',
      '--console-log-level=warn',
      '--download-result=default',
      `--dir=${destination}`,
    ];

    if (selectedIds.length > 0) {
      args.push(`--select-file=${selectedIds.join(',')}`);
    }

    args.push(torrentPath);
    return args;
  }

  _parseAria2Bytes(text) {
    if (!text) return 0;
    const match = String(text).trim().match(/^([\d.]+)\s*([kmgt]?i?b)$/i);
    if (!match) return 0;

    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value) || value < 0) return 0;

    const unit = match[2].toLowerCase();
    const multipliers = {
      b: 1,
      kb: 1000,
      mb: 1000 ** 2,
      gb: 1000 ** 3,
      tb: 1000 ** 4,
      kib: 1024,
      mib: 1024 ** 2,
      gib: 1024 ** 3,
      tib: 1024 ** 4,
    };
    return Math.round(value * (multipliers[unit] || 1));
  }

  _parseAria2ProgressLine(line) {
    if (!line || !line.includes('DL:')) return null;

    const percentMatch = line.match(/\(([\d.]+)%\)/);
    const transferMatch = line.match(/([\d.]+\s*[kmgt]?i?b)\s*\/\s*([\d.]+\s*[kmgt]?i?b)/i);
    const speedMatch = line.match(/DL:([\d.]+\s*[kmgt]?i?b)(?:\/s)?/i);
    const peersMatch = line.match(/(?:CN|SEED|LEECH):\s*(\d+)/i) || line.match(/CN:\s*(\d+)/i);

    const current = transferMatch ? this._parseAria2Bytes(transferMatch[1]) : 0;
    const total = transferMatch ? this._parseAria2Bytes(transferMatch[2]) : 0;
    const parsedPercent = percentMatch ? Number.parseFloat(percentMatch[1]) : Number.NaN;
    const progress = Number.isFinite(parsedPercent)
      ? Math.max(0, Math.min(1, parsedPercent / 100))
      : (total > 0 ? current / total : 0);
    const downloadSpeed = speedMatch ? this._parseAria2Bytes(speedMatch[1]) : 0;
    const numPeers = peersMatch ? Number.parseInt(peersMatch[1], 10) : 0;

    if (!Number.isFinite(progress) || progress < 0) return null;
    return { current, total, progress, downloadSpeed, numPeers };
  }

  async _runAria2ForTorrent(torrentFile, destination) {
    const requestedGameName = torrentFile.requestedGameName;
    const ids = requestedGameName
      ? await this._resolveTorrentFileIdsForGame(torrentFile.name, requestedGameName)
      : [];
    if (requestedGameName && ids.length === 0) {
      return { attempted: false, reason: 'no-id-match' };
    }

    const args = this._buildAria2Args(torrentFile.path, destination, ids);
    await new Promise((resolve, reject) => {
      const proc = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let stdoutBuffer = '';
      proc.stdout.on('data', (chunk) => {
        const text = String(chunk || '');
        if (!text) return;
        stdoutBuffer += text;

        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          const line = rawLine.trim();
          if (line) {
            this.downloadConsole.log(`[aria2] ${line}`);
            const parsed = this._parseAria2ProgressLine(line);
            if (parsed) {
              this.win.webContents.send('torrent-progress', {
                phase: 'progress',
                engine: 'aria2',
                name: torrentFile.name,
                ...parsed,
              });
            }
          }
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk || '').trim();
        if (text) {
          stderr += `${text}\n`;
          this.downloadConsole.log(`[aria2] ${text}`);
        }
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        const trailing = stdoutBuffer.trim();
        if (trailing) {
          this.downloadConsole.log(`[aria2] ${trailing}`);
          const parsed = this._parseAria2ProgressLine(trailing);
          if (parsed) {
            this.win.webContents.send('torrent-progress', {
              phase: 'progress',
              engine: 'aria2',
              name: torrentFile.name,
              ...parsed,
            });
          }
        }
        if (code === 0) return resolve();
        reject(new Error(`aria2c exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
    });

    return { attempted: true, selectedIds: ids };
  }

  async _tryAria2First(torrentFile, destination) {
    try {
      const outcome = await this._runAria2ForTorrent(torrentFile, destination);
      if (outcome.attempted) {
        const selectedInfo = outcome.selectedIds?.length
          ? `${outcome.selectedIds.length} selected file id(s)`
          : 'all files selected';
        this.downloadConsole.log(`aria2c payload download complete for ${torrentFile.name} (${selectedInfo}).`);
      } else if (outcome.reason === 'no-id-match') {
        this.downloadConsole.log(`aria2c skipped for ${torrentFile.name}: no Minerva ID match for requested game.`);
      }
      return outcome;
    } catch (error) {
      const message = String(error?.message || error);
      if (/ENOENT|not found/i.test(message)) {
        this.downloadConsole.log('aria2c not found on PATH, falling back to built-in WebTorrent.');
        return { attempted: false, reason: 'aria2-not-installed' };
      }
      this.downloadConsole.logError(`aria2c failed for ${torrentFile.name}: ${message}. Falling back to WebTorrent.`);
      return { attempted: false, reason: 'aria2-failed' };
    }
  }

  _getPreferredTorrentClient() {
    const preferred = String(this.torrentClient || 'aria2').toLowerCase();
    if (['webtorrent', 'aria2', 'qbittorrent'].includes(preferred)) return preferred;
    return 'aria2';
  }

  async _tryQbittorrentFirst(torrentFile) {
    this.downloadConsole.log(
      `qBittorrent engine selected for ${torrentFile.name}, but WebUI integration is not configured in this build. Falling back to WebTorrent.`
    );
    return { attempted: false, reason: 'qbittorrent-not-configured' };
  }

  /**
   * Downloads payload files for downloaded .torrent manifests.
   * Falls back silently if the optional webtorrent dependency is unavailable.
   * @param {Array<{name: string, path: string}>} downloadedFiles
   * @param {string} targetDir
   * @returns {Promise<void>}
   * @private
   */
  async _downloadFromTorrentFiles(downloadedFiles, targetDir) {
    const torrentFiles = downloadedFiles.filter(
      (f) => f?.path && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.torrent')
    );
    if (torrentFiles.length === 0) return;

    let WebTorrent;
    try {
      const mod = await import('webtorrent');
      WebTorrent = mod.default;
    } catch {
      this.downloadConsole.log('Torrent payload download skipped: install `webtorrent` to enable it.');
      return;
    }

    for (const torrentFile of torrentFiles) {
      if (this.isCancelled) break;
      const destination = path.join(targetDir, path.parse(torrentFile.name).name);
      await fs.promises.mkdir(destination, { recursive: true });
      this.downloadConsole.log(`Starting torrent payload download for ${torrentFile.name}`);
      const preferredEngine = this._getPreferredTorrentClient();
      this.win.webContents.send('torrent-progress', {
        phase: 'start',
        engine: preferredEngine,
        name: torrentFile.name,
        current: 0,
        total: 0,
        progress: 0,
        downloadSpeed: 0,
        numPeers: 0
      });

      const externalOutcome = preferredEngine === 'aria2'
        ? await this._tryAria2First(torrentFile, destination)
        : preferredEngine === 'qbittorrent'
          ? await this._tryQbittorrentFirst(torrentFile, destination)
          : { attempted: false, reason: 'webtorrent-selected' };

      if (externalOutcome.attempted) {
        this.win.webContents.send('torrent-progress', {
          phase: 'done',
          engine: preferredEngine,
          name: torrentFile.name,
          current: 0,
          total: 0,
          progress: 1,
          downloadSpeed: 0,
          numPeers: 0
        });
        continue;
      }

      const client = new WebTorrent();
      try {
        await new Promise((resolve, reject) => {
          let lastActivityAt = Date.now();
          let stalledWithoutPeers = true;
          const markActivity = () => {
            lastActivityAt = Date.now();
            stalledWithoutPeers = false;
          };
          const stallCheckInterval = setInterval(() => {
            const stalledFor = Date.now() - lastActivityAt;
            if (stalledWithoutPeers && stalledFor >= DownloadManager.TORRENT_PAYLOAD_STALL_TIMEOUT_MS) {
              try { client.destroy(); } catch (e) {}
              reject(new Error(
                `Timed out waiting for torrent transfer activity after ${Math.round(DownloadManager.TORRENT_PAYLOAD_STALL_TIMEOUT_MS / 1000)}s`
              ));
            }
          }, 1000);

          const cleanup = () => {
            clearInterval(stallCheckInterval);
            try { client.destroy(); } catch (e) {}
          };

          const torrent = client.add(torrentFile.path, { path: destination });
          torrent.on('ready', async () => {
            const requestedGameName = torrentFile.requestedGameName;
            if (!requestedGameName) return;

            try {
              const ids = await this._resolveTorrentFileIdsForGame(torrentFile.name, requestedGameName);
              const selectedByMapCount = this._applyFileSelection(torrent, ids);
              if (selectedByMapCount > 0) {
                this.downloadConsole.log(
                  `Using Minerva ID mapping for ${torrentFile.name}: selected ${selectedByMapCount} file(s) for "${requestedGameName}".`
                );
                return;
              }

              const normalizedRequested = this._normalizeForMatch(requestedGameName);
              const matchedByName = torrent.files
                .map((f, idx) => ({ file: f, id: idx + 1 }))
                .filter(({ file }) => this._normalizeForMatch(path.basename(file.path)).includes(normalizedRequested));
              if (matchedByName.length > 0) {
                const selectedCount = this._applyFileSelection(torrent, matchedByName.map(({ id }) => id));
                this.downloadConsole.log(
                  `Using filename match fallback for ${torrentFile.name}: selected ${selectedCount} file(s) for "${requestedGameName}".`
                );
                return;
              }

              this.downloadConsole.log(
                `No Minerva ID/filename match found for "${requestedGameName}" in ${torrentFile.name}; downloading full torrent payload.`
              );
            } catch (mappingErr) {
              this.downloadConsole.logError(
                `Failed to apply Minerva ID mapping for ${torrentFile.name}: ${mappingErr.message || mappingErr}`
              );
            }
          });
          const onProgress = () => {
            this.win.webContents.send('torrent-progress', {
              phase: 'progress',
              engine: 'webtorrent',
              name: torrentFile.name,
              current: torrent.downloaded || 0,
              total: torrent.length || 0,
              progress: torrent.progress || 0,
              downloadSpeed: torrent.downloadSpeed || 0,
              numPeers: torrent.numPeers || 0
            });
          };
          torrent.on('wire', markActivity);
          torrent.on('download', markActivity);
          const progressInterval = setInterval(onProgress, 500);
          torrent.on('error', (err) => {
            clearInterval(progressInterval);
            cleanup();
            reject(err);
          });
          torrent.on('warning', () => {});
          torrent.on('done', () => {
            clearInterval(progressInterval);
            onProgress();
            cleanup();
            resolve();
          });
        });
        this.downloadConsole.log(`Torrent payload download complete: ${torrentFile.name}`);
        this.win.webContents.send('torrent-progress', {
          phase: 'done',
          engine: 'webtorrent',
          name: torrentFile.name,
          current: 0,
          total: 0,
          progress: 1,
          downloadSpeed: 0,
          numPeers: 0
        });
      } catch (e) {
        this.downloadConsole.logError(`Torrent payload download failed for ${torrentFile.name}: ${e.message || e}`);
        this.win.webContents.send('torrent-progress', {
          phase: 'error',
          engine: 'webtorrent',
          name: torrentFile.name,
          current: 0,
          total: 0,
          progress: 0,
          downloadSpeed: 0,
          numPeers: 0,
          error: e.message || String(e)
        });
        try { client.destroy(); } catch (destroyErr) {}
      }
    }
  }

  /**
   * Creates an instance of DownloadManager.
   * @param {Electron.BrowserWindow} win The Electron BrowserWindow instance.
   * @param {ConsoleService} downloadConsole An instance of ConsoleService for logging.
   * @param {DownloadInfoService} downloadInfoService An instance of DownloadInfoService.
   * @param {DownloadService} downloadService An instance of DownloadService.
   */
  constructor(win, downloadConsole, downloadInfoService, downloadService) {
    this.win = win;
    this.downloadConsole = downloadConsole;
    this.downloadInfoService = downloadInfoService;
    this.downloadService = downloadService;
    this.isCancelled = false;
    this.torrentClient = 'aria2';
  }

  /**
   * Cancels any ongoing download and information retrieval processes.
   * @memberof DownloadManager
   */
  cancel() {
    this.isCancelled = true;
    this.downloadInfoService.cancel();
    this.downloadService.cancel();
  }

  /**
   * Resets the download manager's state, allowing for new download operations.
   * @memberof DownloadManager
   */
  reset() {
    this.isCancelled = false;
    this.downloadInfoService.reset();
    this.downloadService.reset();
  }

  /**
   * Initiates the download process for a given set of files.
   * @memberof DownloadManager
   * @param {string} baseUrl The base URL for the files to download.
   * @param {Array<object>} files An array of file objects to download.
   * @param {string} targetDir The target directory for the download.
   * @param {boolean} createSubfolder Whether to create subfolders for the download.
   * @param {boolean} maintainFolderStructure Whether to maintain the site's folder structure.
   * @param {boolean} extractAndDelete Whether to extract archives and delete them after download.
   * @param {boolean} extractPreviouslyDownloaded Whether to extract previously downloaded archives.
   * @param {boolean} skipScan Whether to skip the pre-download file size scan.
   * @param {boolean} isThrottlingEnabled Whether download throttling is enabled.
   * @param {number} throttleSpeed The speed for download throttling.
   * @param {string} throttleUnit The unit for download throttling speed (e.g., 'kb', 'mb').
   * @param {'webtorrent'|'aria2'|'qbittorrent'} [torrentClient='aria2'] Preferred torrent engine.
   * @returns {Promise<{success: boolean}>} A promise that resolves with a success status.
   */
  async startDownload(baseUrl, files, targetDir, createSubfolder, maintainFolderStructure, extractAndDelete, extractPreviouslyDownloaded, skipScan, isThrottlingEnabled, throttleSpeed, throttleUnit, torrentClient = 'aria2') {
    this.reset();
    this.torrentClient = torrentClient;

    const downloadStartTime = performance.now();
    let allSkippedFiles = [];
    let totalSize = 0;
    let skippedSize = 0;
    let summaryMessage = "";
    let wasCancelled = false;
    let partialFile = null;
    let downloadedFiles = [];
    let filesToDownload = [];
    let scanResult;

    try {
      if (skipScan) {
        this.downloadConsole.log('Skipping file size scan. Using estimates.');
        this.win.webContents.send('download-scan-progress', { current: 1, total: 1, message: "Scan skipped" });

        const processedFiles = files.map(f => {
          const parsedFileSize = parseSize(f.size);
          return {
            ...f,
            name: f.name_raw,
            href: new URL(f.href, baseUrl).href,
            size: parsedFileSize,
            path: null
          };
        });

        totalSize = processedFiles.reduce((acc, file) => acc + (file.size || 0), 0);

        scanResult = {
          filesToDownload: processedFiles,
          totalSize: totalSize,
          skippedSize: 0,
          skippedFiles: [],
          skippedBecauseDownloadedCount: 0,
          skippedBecauseExtractedCount: 0,
        };
      } else {
        scanResult = await this.downloadInfoService.getDownloadInfo(this.win, baseUrl, files, targetDir, createSubfolder, maintainFolderStructure);
      }

      if (this.isCancelled) {
        throw new Error("CANCELLED_DURING_SCAN");
      }


      filesToDownload = scanResult.filesToDownload;
      totalSize = scanResult.totalSize;
      skippedSize = scanResult.skippedSize;
      allSkippedFiles.push(...scanResult.skippedFiles.filter(f => f.skippedBecauseExtracted).map(f => f.name));

      if (filesToDownload.length === 0) {
        if (scanResult.skippedBecauseExtractedCount === files.length) {
          summaryMessage = "All files already extracted!";
        } else if (scanResult.skippedBecauseDownloadedCount === files.length) {
          summaryMessage = "All files already downloaded!";
        } else {
          const scanFailedFiles = scanResult.skippedFiles.filter(f => typeof f === 'string' && f.includes('Scan failed'));
          if (scanFailedFiles.length > 0) {
            summaryMessage = `Scan failed for ${scanFailedFiles.length} file(s). First error: ${scanFailedFiles[0]}`;
          } else {
            summaryMessage = "All matched files already exist locally. Nothing to download.";
          }
        }
      } else {
        const remainingSize = totalSize - skippedSize;
        this.downloadConsole.logTotalDownloadSize(formatBytes(remainingSize));
        const estimatedTorrentPayloadBytes = filesToDownload.reduce((sum, file) => {
          const payload = Number(file?.payloadSize || 0);
          return sum + (Number.isFinite(payload) && payload > 0 ? payload : 0);
        }, 0);
        if (estimatedTorrentPayloadBytes > 0) {
          this.downloadConsole.log(
            `Estimated torrent payload size: ${formatBytes(estimatedTorrentPayloadBytes)} (downloaded after .torrent metadata).`
          );
        }
        this.win.webContents.send('download-overall-progress', { current: skippedSize, total: totalSize, skippedSize: skippedSize, eta: calculateEta(skippedSize, totalSize, downloadStartTime), isFinal: false });

        const totalFilesOverall = files.length;
        const initialSkippedFileCount = scanResult.skippedFiles.length;

        const downloadResult = await this.downloadService.downloadFiles(
          this.win,
          baseUrl,
          filesToDownload,
          targetDir,
          totalSize,
          skippedSize,
          createSubfolder,
          maintainFolderStructure,
          totalFilesOverall,
          initialSkippedFileCount,
          isThrottlingEnabled,
          throttleSpeed,
          throttleUnit
        );
        allSkippedFiles.push(...downloadResult.skippedFiles);
        downloadedFiles = downloadResult.downloadedFiles;
      }

    } catch (e) {
      if (e.message.startsWith('CANCELLED_')) {
        summaryMessage = "";
      } else {
        console.error("DownloadManager: Generic error caught in startDownload:", e);
        summaryMessage = `Error: ${e.message || e}`;
      }
      wasCancelled = true;
      partialFile = e.partialFile || null;
    }

    if (wasCancelled || this.isCancelled) {
      this.downloadConsole.logDownloadCancelled();
      summaryMessage = "";
      wasCancelled = true;
    } else if (downloadedFiles.length > 0 || filesToDownload.length === 0) {
      this.downloadConsole.logDownloadComplete();
    }

    if (summaryMessage) {
      this.downloadConsole.log(summaryMessage);
    }

    if (!wasCancelled) {
      this.win.webContents.send('download-overall-progress', {
        current: totalSize,
        total: totalSize,
        skippedSize: 0,
        isFinal: true
      });
    }

    let filesForExtraction = [...downloadedFiles];
    if (extractPreviouslyDownloaded && scanResult && scanResult.skippedFiles) {
      const previouslyDownloadedArchives = scanResult.skippedFiles.filter(file =>
        file.skippedBecauseDownloaded &&
        file.path &&
        fs.existsSync(file.path) &&
        !allSkippedFiles.includes(file.name)
      );
      filesForExtraction.push(...previouslyDownloadedArchives);
    }

    if (extractAndDelete && !wasCancelled && filesForExtraction.length > 0) {
      this.downloadConsole.logDownloadStartingExtraction();
      await this.extractFiles(filesForExtraction, targetDir, createSubfolder, maintainFolderStructure);
    }

    if (!wasCancelled && downloadedFiles.length > 0) {
      try {
        await this._downloadFromTorrentFiles(downloadedFiles, targetDir);
      } catch (e) {
        this.downloadConsole.logError(`Torrent payload stage failed: ${e.message || e}`);
      }
    }

    this.win.webContents.send('download-complete', {
      message: "",
      skippedFiles: allSkippedFiles,
      wasCancelled: wasCancelled,
      partialFile: partialFile
    });

    return { success: true };
  }

  /**
   * Extracts downloaded archive files.
   * @memberof DownloadManager
   * @param {Array<object>} downloadedFiles An array of file objects that have been downloaded, including a 'path' property.
   * @param {string} targetDir The target directory for extraction.
   * @param {boolean} [createSubfolder=false] Whether to extract into subfolders based on archive name.
   * @param {boolean} [maintainFolderStructure=false] Whether the site's folder structure was maintained during download.
   * @returns {Promise<void>}
   */
  async extractFiles(downloadedFiles, targetDir, createSubfolder, maintainFolderStructure) {
    const extractionStartTime = performance.now();
    this.win.webContents.send('extraction-started');
    let archiveFiles = downloadedFiles.filter(f => f.name.toLowerCase().endsWith('.zip'));

    const uniquePaths = new Map();
    archiveFiles.forEach(file => {
      if (file.path) {
        uniquePaths.set(file.path, file);
      }
    });
    archiveFiles = Array.from(uniquePaths.values());

    if (archiveFiles.length === 0) {
      this.downloadConsole.logNoArchivesToExtract();
      return;
    }

    this.downloadConsole.logFoundArchivesToExtract(archiveFiles.length);

    let totalUncompressedSizeOfAllArchives = 0;
    let overallExtractedBytes = 0;
    let overallExtractedEntryCount = 0;
    let lastExtractionProgressUpdateTime = 0;

    let totalEntriesOverall = 0;
    for (const file of archiveFiles) {
      const filePath = file.path;
      if (!filePath || !fs.existsSync(filePath)) {
        this.downloadConsole.logError(`Archive not found at ${filePath}, skipping metadata scan.`);
        continue;
      }
      let zipfile;
      try {
        zipfile = await open(filePath);
        let entry = await zipfile.readEntry();
        while (entry) {
          totalEntriesOverall++;
          if (entry.uncompressedSize > 0) {
            totalUncompressedSizeOfAllArchives += entry.uncompressedSize;
          }
          entry = await zipfile.readEntry();
        }
      } catch (e) {
        this.downloadConsole.logError(`Error reading metadata for ${file.name}: ${e.message}`);
      } finally {
        if (zipfile) {
          await zipfile.close();
        }
      }
    }

    this.downloadConsole.logTotalUncompressedSize(formatBytes(totalUncompressedSizeOfAllArchives));


    for (let i = 0; i < archiveFiles.length; i++) {
      const file = archiveFiles[i];
      const archiveBaseName = path.parse(file.name).name;

      let extractPath;
      if (maintainFolderStructure) {
        extractPath = path.dirname(file.path);
      } else if (createSubfolder) {
        extractPath = path.join(targetDir, archiveBaseName);
      } else {
        extractPath = targetDir;
      }

      const filePath = file.path;
      if (!filePath || !fs.existsSync(filePath)) {
        this.downloadConsole.logError(`Archive not found at ${filePath}, skipping extraction.`);
        continue;
      }

      let zipfile;
      const extractedFiles = [];
      try {
        this.win.webContents.send('extraction-progress', {
          current: i,
          total: archiveFiles.length,
          filename: file.name,
          fileProgress: 0,
          fileTotal: 0,
          currentEntry: 0,
          totalEntries: 0,
          overallExtractedBytes: overallExtractedBytes,
          totalUncompressedSizeOfAllArchives: totalUncompressedSizeOfAllArchives,
          overallExtractedEntryCount: overallExtractedEntryCount,
          totalEntriesOverall: totalEntriesOverall,
          eta: calculateEta(overallExtractedBytes, totalUncompressedSizeOfAllArchives, extractionStartTime)
        });

        zipfile = await open(filePath);
        let totalEntries = 0;
        let entry = await zipfile.readEntry();
        while (entry) {
          totalEntries++;
          entry = await zipfile.readEntry();
        }
        await zipfile.close();

        zipfile = await open(filePath);

        let extractedEntryCount = 0;
        entry = await zipfile.readEntry();
        while (entry) {
          if (this.isCancelled) {
            this.downloadConsole.logExtractionCancelled();
            break;
          }
          extractedEntryCount++;
          overallExtractedEntryCount++;
          const currentEntryFileName = entry.fileName || entry.filename;
          if (!currentEntryFileName || typeof currentEntryFileName !== 'string') {
            entry = await zipfile.readEntry();
            continue;
          }

          let finalEntryFileName = currentEntryFileName;
          if (createSubfolder && finalEntryFileName.startsWith(archiveBaseName + '/')) {
            finalEntryFileName = finalEntryFileName.substring(archiveBaseName.length + 1);
          }

          const entryPath = path.join(extractPath, finalEntryFileName);
          if (/\/$/.test(finalEntryFileName) && entry.uncompressedSize === 0) {
            await fs.promises.mkdir(entryPath, { recursive: true });
            entry = await zipfile.readEntry();
            continue;
          }
          if (/\/$/.test(finalEntryFileName)) {
            await fs.promises.mkdir(entryPath, { recursive: true });
          } else {
            await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
            extractedFiles.push(entryPath);
            
            const partPath = `${entryPath}.part`;
            const readStream = await entry.openReadStream();
            const writeStream = fs.createWriteStream(partPath);
            let bytesRead = 0;
            const totalBytes = entry.uncompressedSize;
            this.win.webContents.send('extraction-progress', {
              current: i,
              total: archiveFiles.length,
              filename: file.name,
              fileProgress: 0,
              fileTotal: totalBytes,
              currentEntry: extractedEntryCount,
              totalEntries: totalEntries,
              overallExtractedBytes: overallExtractedBytes,
              totalUncompressedSizeOfAllArchives: totalUncompressedSizeOfAllArchives,
              overallExtractedEntryCount: overallExtractedEntryCount,
              totalEntriesOverall: totalEntriesOverall,
              formattedOverallExtractedBytes: formatBytes(overallExtractedBytes),
              formattedTotalUncompressedSizeOfAllArchives: formatBytes(totalUncompressedSizeOfAllArchives),
              eta: calculateEta(overallExtractedBytes, totalUncompressedSizeOfAllArchives, extractionStartTime)
            });
            await new Promise((resolve, reject) => {
              let cancelledDuringWrite = false;
              readStream.on('data', (chunk) => {
                bytesRead += chunk.length;
                overallExtractedBytes += chunk.length;
                const now = performance.now();
                if (now - lastExtractionProgressUpdateTime > 100 || bytesRead === totalBytes) {
                  lastExtractionProgressUpdateTime = now;
                  this.win.webContents.send('extraction-progress', {
                    current: i,
                    total: archiveFiles.length,
                    filename: file.name,
                    fileProgress: bytesRead,
                    fileTotal: totalBytes,
                    currentEntry: extractedEntryCount,
                    totalEntries: totalEntries,
                    overallExtractedBytes: overallExtractedBytes,
                    totalUncompressedSizeOfAllArchives: totalUncompressedSizeOfAllArchives,
                    overallExtractedEntryCount: overallExtractedEntryCount,
                    totalEntriesOverall: totalEntriesOverall,
                    formattedOverallExtractedBytes: formatBytes(overallExtractedBytes),
                    formattedTotalUncompressedSizeOfAllArchives: formatBytes(totalUncompressedSizeOfAllArchives),
                    eta: calculateEta(overallExtractedBytes, totalUncompressedSizeOfAllArchives, extractionStartTime)
                  });
                }
                if (this.isCancelled && !cancelledDuringWrite) {
                  cancelledDuringWrite = true;
                  readStream.destroy(new Error('Extraction cancelled'));
                  writeStream.destroy(new Error('Extraction cancelled'));
                }
              });
              readStream.pipe(writeStream);
              writeStream.on('finish', () => {
                if (!this.isCancelled) {
                  fs.rename(partPath, entryPath, (err) => {
                    if (err) {
                      return reject(err);
                    }
                    this.win.webContents.send('extraction-progress', {
                      current: i,
                      total: archiveFiles.length,
                      filename: file.name,
                      fileProgress: totalBytes,
                      fileTotal: totalBytes,
                      currentEntry: extractedEntryCount,
                      totalEntries: totalEntries,
                      overallExtractedBytes: overallExtractedBytes,
                      totalUncompressedSizeOfAllArchives: totalUncompressedSizeOfAllArchives,
                      overallExtractedEntryCount: overallExtractedEntryCount,
                      totalEntriesOverall: totalEntriesOverall,
                      formattedOverallExtractedBytes: formatBytes(overallExtractedBytes),
                      formattedTotalUncompressedSizeOfAllArchives: formatBytes(totalUncompressedSizeOfAllArchives),
                      eta: calculateEta(overallExtractedBytes, totalUncompressedSizeOfAllArchives, extractionStartTime)
                    });
                    resolve();
                  });
                } else {
                  resolve();
                }
              });
              writeStream.on('error', (err) => {
                if (!this.isCancelled || err.message !== 'Extraction cancelled') {
                  this.downloadConsole.logError('Write stream error during extraction: ' + err.message);
                }
                reject(err);
              });
              readStream.on('error', (err) => {
                if (!this.isCancelled || err.message !== 'Extraction cancelled') {
                  this.downloadConsole.logError('Read stream error during extraction: ' + err.message);
                }
                reject(err);
              });
            });
          }
          entry = await zipfile.readEntry();
        }
        if (!this.isCancelled) {
          await fs.promises.unlink(filePath);
        }
      } catch (e) {
        this.downloadConsole.logExtractionError(file.name, e.message);
      } finally {
        if (zipfile) {
          await zipfile.close();
        }
        if (this.isCancelled && extractedFiles.length > 0) {
          for (const extractedFile of extractedFiles) {
            try {
              if (fs.existsSync(extractedFile)) {
                await fs.promises.unlink(extractedFile);
              }
              const partFile = `${extractedFile}.part`;
              if (fs.existsSync(partFile)) {
                await fs.promises.unlink(partFile);
              }
            } catch (cleanupErr) {
              this.downloadConsole.logError(`Failed to clean up ${extractedFile}: ${cleanupErr.message}`);
            }
          }
        }
      }
      if (this.isCancelled) {
        break;
      }
    }

    this.win.webContents.send('extraction-progress', {
      current: archiveFiles.length,
      total: archiveFiles.length,
      filename: '',
      fileProgress: 0,
      fileTotal: 0,
      currentEntry: 0,
      totalEntries: 0,
      overallExtractedBytes: this.isCancelled ? overallExtractedBytes : totalUncompressedSizeOfAllArchives,
      totalUncompressedSizeOfAllArchives: totalUncompressedSizeOfAllArchives,
      overallExtractedEntryCount: this.isCancelled ? overallExtractedEntryCount : totalEntriesOverall,
      totalEntriesOverall: totalEntriesOverall,
      formattedOverallExtractedBytes: formatBytes(this.isCancelled ? overallExtractedBytes : totalUncompressedSizeOfAllArchives),
      formattedTotalUncompressedSizeOfAllArchives: formatBytes(totalUncompressedSizeOfAllArchives),
      eta: '--'
    });
    if (this.isCancelled) {
      this.downloadConsole.logExtractionCancelled();
      this.win.webContents.send('extraction-ended');
    } else {
      this.downloadConsole.logExtractionProcessComplete();
      this.win.webContents.send('extraction-ended');
    }
  }
}

export default DownloadManager;
