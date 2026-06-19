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

  static LOCAL_MINERVA_IDS_DIR_CANDIDATES = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../vendor/minerva-archive-ids/markdown-files'),
    path.resolve(process.cwd(), 'markdown'),
    path.resolve(process.cwd(), 'vendor/minerva-archive-ids/markdown-files'),
  ];

  static ARIA2_BINARY_NAME = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';

  static LOCAL_ARIA2_DIR_CANDIDATES = [
    path.resolve(process.cwd(), 'aria2'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../aria2'),
    path.resolve(process.resourcesPath || process.cwd(), 'aria2'),
    path.resolve(process.resourcesPath || process.cwd(), 'app.asar.unpacked/aria2'),
  ];

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

  _normalizeTorrentMapName(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\.torrent(?:-ids\.md)?$/i, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  }

  async _findLocalIdsMapPath(fileName) {
    const target = this._normalizeTorrentMapName(fileName);

    for (const dirPath of DownloadManager.LOCAL_MINERVA_IDS_DIR_CANDIDATES) {
      const directPath = path.join(dirPath, fileName);
      try {
        await fs.promises.access(directPath, fs.constants.R_OK);
        return directPath;
      } catch {
        // continue to fuzzy lookup in this candidate directory
      }

      let dirEntries = [];
      try {
        dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const mdNames = dirEntries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('-ids.md'))
        .map((entry) => entry.name);
      if (mdNames.length === 0) continue;

      const exact = mdNames.find((name) => this._normalizeTorrentMapName(name) === target);
      if (exact) return path.join(dirPath, exact);

      const loose = mdNames.find((name) => {
        const normalized = this._normalizeTorrentMapName(name);
        return normalized.includes(target) || target.includes(normalized);
      });
      if (loose) return path.join(dirPath, loose);
    }

    return null;
  }

  async _loadIdsMarkdownForTorrent(torrentName) {
    const fileName = `${torrentName}-ids.md`;
    const localPath = await this._findLocalIdsMapPath(fileName);
    try {
      if (localPath) {
        const localContents = await fs.promises.readFile(localPath, 'utf8');
        if (typeof localContents === 'string' && localContents.trim()) {
          return localContents;
        }
      }
    } catch {
      // Local vendored map not found; continue with remote fallback.
    }

    const encodedCandidates = [
      encodeURIComponent(fileName).replace(/%2F/g, '/'),
      fileName,
    ];
    const baseCandidates = [
      'https://raw.githubusercontent.com/Caprico1/Minerva-archive-ids/main/markdown-files/',
      MINERVA_IDS_RAW_BASE_URL,
    ];

    for (const baseUrl of baseCandidates) {
      for (const encodedFileName of encodedCandidates) {
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

  async _resolveTorrentFileEntriesForGame(torrentFileName, requestedGameName) {
    if (!torrentFileName || !requestedGameName) return [];
    const markdown = await this._loadIdsMarkdownForTorrent(torrentFileName);
    if (!markdown) return [];
    const parsedRows = this._parseMarkdownIdRows(markdown);
    if (parsedRows.length === 0) return [];

    const requestedBaseName = path.basename(String(requestedGameName || '')).trim().toLowerCase();
    if (requestedBaseName) {
      const rawExactRows = parsedRows.filter((row) => path.basename(String(row.fileName || '')).trim().toLowerCase() === requestedBaseName);
      if (rawExactRows.length > 0) return rawExactRows;
    }

    const target = this._normalizeForMatch(requestedGameName);
    const targetTokens = target.split(' ').filter(Boolean);

    const scored = parsedRows.map((row) => {
      const normalized = this._normalizeForMatch(path.basename(row.fileName));
      const nameTokens = normalized.split(' ').filter(Boolean);
      const commonTokenCount = targetTokens.filter((token) => nameTokens.includes(token)).length;
      const tokenCoverage = targetTokens.length > 0 ? commonTokenCount / targetTokens.length : 0;
      const isExact = normalized === target;
      const isContains = normalized.includes(target) || target.includes(normalized);
      const lengthDelta = Math.abs(normalized.length - target.length);

      let rank = 99;
      if (isExact) rank = 0;
      else if (tokenCoverage >= 1) rank = 1;
      else if (isContains && tokenCoverage >= 0.6) rank = 2;
      else if (isContains) rank = 3;
      else if (tokenCoverage >= 0.6) rank = 4;

      return { row, rank, tokenCoverage, lengthDelta };
    }).filter((entry) => entry.rank < 99);

    if (scored.length === 0) return [];

    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (b.tokenCoverage !== a.tokenCoverage) return b.tokenCoverage - a.tokenCoverage;
      if (a.lengthDelta !== b.lengthDelta) return a.lengthDelta - b.lengthDelta;
      return a.row.id - b.row.id;
    });

    const best = scored[0];
    return scored
      .filter((entry) => entry.rank === best.rank && entry.lengthDelta === best.lengthDelta)
      .map((entry) => entry.row);
  }

  async _resolveTorrentFileIdsForGame(torrentFileName, requestedGameName) {
    const rows = await this._resolveTorrentFileEntriesForGame(torrentFileName, requestedGameName);
    return rows.map((row) => row.id);
  }

  async _cleanupAria2NonSelectedFiles(destination, selectedEntries = []) {
    if (!destination || selectedEntries.length === 0) return;

    const allowedBasenames = new Set(
      selectedEntries
        .map((entry) => path.basename(String(entry.fileName || '')).trim().toLowerCase())
        .filter(Boolean)
    );
    const allowedNames = new Set(
      selectedEntries
        .map((entry) => this._normalizeForMatch(path.basename(entry.fileName)))
        .filter(Boolean)
    );
    if (allowedBasenames.size === 0 && allowedNames.size === 0) return;

    const allFiles = [];
    const walk = async (dir) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          allFiles.push(fullPath);
        }
      }
    };
    await walk(destination);

    let removed = 0;
    for (const filePath of allFiles) {
      const basename = path.basename(filePath).trim().toLowerCase();
      const normalized = this._normalizeForMatch(path.basename(filePath));
      if (!allowedBasenames.has(basename) && (allowedBasenames.size > 0 || !allowedNames.has(normalized))) {
        await fs.promises.unlink(filePath).catch(() => {});
        removed += 1;
      }
    }
    if (removed > 0) {
      this.downloadConsole.log(`aria2 cleanup removed ${removed} non-selected file(s) from ${destination}.`);
    }
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

  _getAria2ExecutablePath() {
    for (const dirPath of DownloadManager.LOCAL_ARIA2_DIR_CANDIDATES) {
      const candidate = path.join(dirPath, DownloadManager.ARIA2_BINARY_NAME);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Continue to the next candidate and eventually fall back to PATH.
      }
    }
    return 'aria2c';
  }

  _buildAria2Args(torrentPath, destination, selectedIds = []) {
    const args = [
      '--summary-interval=1',
      '--enable-color=false',
      '--seed-time=0',
      '--bt-remove-unselected-file=true',
      '--continue=true',
      '--allow-overwrite=true',
      '--file-allocation=none',
      `--bt-stop-timeout=${Math.ceil(DownloadManager.TORRENT_PAYLOAD_STALL_TIMEOUT_MS / 1000)}`,
    ];

    if (selectedIds.length > 0) {
      args.push(`--select-file=${selectedIds.join(',')}`);
    }

    args.push(torrentPath);
    args.push('-d', destination);
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

  async _resolveExistingFileIds(torrentFileName, destination) {
    const markdown = await this._loadIdsMarkdownForTorrent(torrentFileName);
    if (!markdown) return [];
    const allRows = this._parseMarkdownIdRows(markdown);
    if (allRows.length === 0) return [];

    const existingBasenames = new Set();
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else existingBasenames.add(entry.name.trim().toLowerCase());
      }
    };
    await walk(destination);
    if (existingBasenames.size === 0) return [];

    return allRows
      .filter((row) => existingBasenames.has(path.basename(row.fileName).trim().toLowerCase()))
      .map((row) => row.id);
  }

  async _runAria2ForTorrent(torrentFile, destination, requestedGameNames = []) {
    const names = requestedGameNames.filter(Boolean);
    let ids = [];
    if (names.length > 0) {
      const rowArrays = await Promise.all(
        names.map((name) => this._resolveTorrentFileEntriesForGame(torrentFile.name, name))
      );
      ids = [...new Set(rowArrays.flat().map((row) => row.id))];
      if (ids.length === 0) {
        return { attempted: false, reason: 'no-id-match' };
      }
    }

    const existingIds = await this._resolveExistingFileIds(torrentFile.name, destination);
    if (existingIds.length > 0) {
      const merged = new Set([...ids, ...existingIds]);
      ids = [...merged];
      this.downloadConsole.log(`Preserving ${existingIds.length} already-downloaded file(s) in selection.`);
    }

    const args = this._buildAria2Args(torrentFile.path, destination, ids);
    const executablePath = this._getAria2ExecutablePath();
    this.downloadConsole.log(`Launching aria2c from ${executablePath} for ${torrentFile.name}.`);
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          if (stallTimer) clearInterval(stallTimer);
          if (this.activeAria2Process === proc) this.activeAria2Process = null;
          fn(value);
        };
        const proc = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        this.activeAria2Process = proc;
        let stderr = '';
        let stdoutBuffer = '';
        let lastActiveAt = Date.now();
        let lastDownloadedBytes = 0;
        stallTimer = setInterval(() => {
          if (Date.now() - lastActiveAt > DownloadManager.TORRENT_PAYLOAD_STALL_TIMEOUT_MS) {
            this.downloadConsole.logError(`aria2c stalled for ${torrentFile.name}; stopping torrent payload download.`);
            proc.kill('SIGTERM');
            finish(reject, new Error('aria2c stalled with no peers or payload progress'));
          }
        }, 5000);
        const noteAria2Progress = (parsed) => {
          if (!parsed) return;
          if (parsed.current > lastDownloadedBytes || parsed.downloadSpeed > 0 || parsed.numPeers > 0) {
            lastDownloadedBytes = Math.max(lastDownloadedBytes, parsed.current);
            lastActiveAt = Date.now();
          }
        };
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
                noteAria2Progress(parsed);
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
        proc.on('error', (err) => finish(reject, err));
        proc.on('close', (code) => {
          const trailing = stdoutBuffer.trim();
          if (trailing) {
            this.downloadConsole.log(`[aria2] ${trailing}`);
            const parsed = this._parseAria2ProgressLine(trailing);
            if (parsed) {
              noteAria2Progress(parsed);
              this.win.webContents.send('torrent-progress', {
                phase: 'progress',
                engine: 'aria2',
                name: torrentFile.name,
                ...parsed,
              });
            }
          }
          if (this.isCancelled) {
            return finish(reject, new Error('CANCELLED_TORRENT_PAYLOAD'));
          }
          if (code === 0) return finish(resolve);
          finish(reject, new Error(`aria2c exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        });
      });
    } catch (error) {
      throw error;
    }

    return { attempted: true, selectedIds: ids };
  }

  async _tryAria2First(torrentFile, destination, requestedGameNames = []) {
    try {
      const outcome = await this._runAria2ForTorrent(torrentFile, destination, requestedGameNames);
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
        this.downloadConsole.log('aria2c not found in the bundled aria2 folder or on PATH.');
        return { attempted: false, reason: 'aria2-not-installed' };
      }
      this.downloadConsole.logError(`aria2c failed for ${torrentFile.name}: ${message}.`);
      return { attempted: false, reason: 'aria2-failed' };
    }
  }

  _getPreferredTorrentClient() {
    const preferred = String(this.torrentClient || 'aria2').toLowerCase();
    if (preferred !== 'aria2') {
      this.downloadConsole.log(`Torrent engine "${preferred}" requested; forcing aria2 mode (Minerva IDs README flow).`);
    }
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

    // Group entries by torrent name so all requested games from the same torrent
    // are passed to aria2 in a single invocation with a combined --select-file list.
    const torrentGroups = new Map();
    for (const torrentFile of torrentFiles) {
      const key = torrentFile.name;
      if (!torrentGroups.has(key)) {
        torrentGroups.set(key, { torrentFile, requestedGameNames: [] });
      }
      if (torrentFile.requestedGameName) {
        torrentGroups.get(key).requestedGameNames.push(torrentFile.requestedGameName);
      }
    }

    for (const { torrentFile, requestedGameNames } of torrentGroups.values()) {
      if (this.isCancelled) break;
      const destination = targetDir;
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

      const externalOutcome = await this._tryAria2First(torrentFile, destination, requestedGameNames);
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

      const reason = externalOutcome.reason || 'aria2-not-run';
      const error = reason === 'no-id-match'
        ? `No Minerva IDs matched requested file for ${torrentFile.name}.`
        : reason === 'aria2-not-installed'
          ? 'aria2c was not found in the bundled aria2 folder or on PATH.'
          : `aria2 flow failed: ${reason}`;
      this.downloadConsole.logError(`Torrent payload download failed for ${torrentFile.name}: ${error}`);
      this.win.webContents.send('torrent-progress', {
        phase: 'error',
        engine: preferredEngine,
        name: torrentFile.name,
        current: 0,
        total: 0,
        progress: 0,
        downloadSpeed: 0,
        numPeers: 0,
        error
      });
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
    this.activeAria2Process = null;
  }

  /**
   * Cancels any ongoing download and information retrieval processes.
   * @memberof DownloadManager
   */
  cancel() {
    this.isCancelled = true;
    this.downloadInfoService.cancel();
    this.downloadService.cancel();
    if (this.activeAria2Process && !this.activeAria2Process.killed) {
      this.activeAria2Process.kill('SIGTERM');
    }
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
