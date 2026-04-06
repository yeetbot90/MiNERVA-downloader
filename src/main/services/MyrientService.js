import https from 'https';
import { URL } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import FileParserService from './FileParserService.js';
import { HTTP_USER_AGENT } from '../../shared/constants/appConstants.js';

const CONCURRENCY_LIMIT = 5;

/**
 * Service responsible for interacting with the Myrient website to fetch directory listings and file information.
 * @class
 */
class MyrientService {
  /**
   * Creates an instance of MyrientService.
   * @param {FileParserService} fileParser An instance of FileParserService.
   */
  constructor(fileParser) {
    this.fileParser = fileParser;
    this.httpAgent = new https.Agent({ keepAlive: true });
    this.scrapeClient = axios.create({
      httpsAgent: this.httpAgent,
      timeout: 15000,
      headers: { 'User-Agent': HTTP_USER_AGENT },
    });
  }

  /**
   * Fetches the content of a given URL.
   * @memberof MyrientService
   * @param {string} url The URL to fetch.
   * @returns {Promise<string>} A promise that resolves with the HTML content of the page.
   * @throws {Error} If the page fails to fetch or an invalid URL is provided.
   */
  async getPage(url) {
    if (typeof url !== 'string' || !url) {
      throw new Error(`Invalid URL provided to getPage: ${url}`);
    }
    try {
      const response = await this.scrapeClient.get(url);
      return response.data;
    } catch (err) {
      throw new Error(`Failed to fetch directory. Please check your connection and try again. Original error: ${err.message}`);
    }
  }

  /**
   * Parses HTML content to extract relevant links for the current directory listing.
   * Supports classic relative listings (e.g. Apache) and MiNERVA-style root-relative `/browse/...` or absolute same-origin URLs.
   * @memberof MyrientService
   * @param {string} html The HTML content to parse.
   * @param {string} [pageUrl] Absolute URL of the page being parsed (required for `/` and `https://` links).
   * @returns {Array<{name: string, href: string, isDir: boolean}>} An array of link objects, each with `name`, `href`, and `isDir` properties.
   */
  parseLinks(html, pageUrl) {
    const $ = cheerio.load(html);
    const links = [];

    const legacyAccept = (h) =>
      h &&
      !h.startsWith('?') &&
      !h.startsWith('http') &&
      !h.startsWith('/') &&
      !h.split('/').includes('..') &&
      h !== './';

    let base = null;
    let currentPrefix = '';
    if (typeof pageUrl === 'string' && pageUrl) {
      try {
        base = new URL(pageUrl);
        currentPrefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
      } catch {
        base = null;
      }
    }

    $('a').each((i, el) => {
      const href = $(el).attr('href');
      // Filter empty, parent-dir links, and Apache sort links (?C=N&O=D etc.) but
      // NOT ?name=... query-only links that some pages use for /rom/ downloads.
      if (!href || href === './' || (href.startsWith('?') && !href.startsWith('?name='))) return;

      let outHref = href;
      let name;
      let isDir;

      if (base) {
        let resolved;
        try {
          resolved = new URL(href, base);
        } catch {
          return;
        }
        if (resolved.origin !== base.origin) return;

        const pathDecoded = decodeURI(resolved.pathname);
        if (pathDecoded.split('/').includes('..')) return;

        // MiNERVA Archive file downloads use /rom/?name=<path>, not /browse/.../file.
        // Also handle query-only hrefs like ?name=... resolved against the /rom/ base.
        const normalizedPath = resolved.pathname.replace(/\/$/, '');
        if (normalizedPath === '/rom') {
          // searchParams.get() already decodes %2F → / and %20 → space.
          // Do NOT call decodeURIComponent again — it would corrupt names with literal % chars.
          const nameParam = resolved.searchParams.get('name');
          if (!nameParam) return;
          const archivePath = nameParam; // already decoded by URLSearchParams
          if (archivePath.endsWith('/')) return;
          const pathParts = archivePath.replace(/^\.\/+/, '').split(/[/\\]/).filter(Boolean);
          name = pathParts.length ? pathParts[pathParts.length - 1] : archivePath;
          if (!name) return;
          const rowRom = $(el).closest('tr');
          let sizeRom = rowRom.length ? rowRom.find('td.size').text().trim() : '';
          if (!sizeRom) {
            sizeRom = $(el).closest('.entry').find('span').first().text().trim();
          }
          links.push({
            name,
            href: resolved.href,
            isDir: false,
            size: sizeRom || null,
          });
          return;
        }

        if (!resolved.pathname.startsWith(currentPrefix) || resolved.pathname.length <= currentPrefix.length) {
          return;
        }

        const remainder = resolved.pathname.slice(currentPrefix.length);
        const segments = remainder.replace(/\/$/, '').split('/').filter(Boolean);
        if (segments.length !== 1) return;

        // One segment relative to the current listing (e.g. No-Intro/). The renderer joins
        // stack hrefs and resolves with new URL(path, baseUrl); absolute URLs break that join.
        outHref = remainder;
        const segment = segments[0];
        name = decodeURIComponent(segment);
        isDir = resolved.pathname.endsWith('/');
      } else if (legacyAccept(href)) {
        isDir = href.endsWith('/');
        name = decodeURIComponent(href.replace(/\/$/, ''));
      } else {
        return;
      }

      const row = $(el).closest('tr');
      let size = row.length ? row.find('td.size').text().trim() : '';
      if (!size) {
        size = $(el).closest('.entry').find('span').first().text().trim();
      }

      links.push({
        name,
        href: outHref,
        isDir,
        size: isDir ? null : size || null
      });
    });

    const seen = new Set();
    return links.filter((l) => {
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });
  }

  /**
   * Fetches and parses the list of directories from a given URL.
   * This method replaces the previous `getMainArchives` and `getDirectoryList` methods.
   * @memberof MyrientService
   * @param {string} url The URL to fetch directories from.
   * @returns {Promise<{data: Array<{name: string, href: string, isDir: boolean}>>}>} A promise that resolves with an object containing a sorted array of directory link objects.
   */
  async getDirectory(url) {
    const html = await this.getPage(url);
    const links = this.parseLinks(html, url);
    const directories = links.filter(link => link.isDir);
    const files = links.filter(link => !link.isDir);
    return {
      data: {
        directories: directories.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      }
    };
  }

  /**
   * Recursively scrapes a given URL for file and directory links and collects all raw file link objects.
   * This is an internal helper method.
   * @private
   * @memberof MyrientService
   * @param {string} url The URL of the page containing file and directory links.
   * @param {string} baseUrl The initial URL from which the scraping started, used to construct full relative paths.
   * @returns {Promise<Array<{name: string, href: string, isDir: boolean, type: string}>>} A promise that resolves with an array of raw file link objects.
   * @throws {Error} If an invalid URL or baseUrl is provided.
   */
  async _scrapeRawFileLinks(url, baseUrl) {
    if (typeof url !== 'string' || !url) {
      throw new Error(`Invalid URL provided to _scrapeRawFileLinks: ${url}`);
    }
    if (typeof baseUrl !== 'string' || !baseUrl) {
      throw new Error(`Invalid baseUrl provided to _scrapeRawFileLinks: ${baseUrl}`);
    }
    let allRawFileLinks = [];
    const html = await this.getPage(url);
    const links = this.parseLinks(html, url);

    const currentLevelFiles = [];
    const subdirectories = [];

    links.forEach(link => {
      if (link.isDir) {
        subdirectories.push(link);
      } else {
        // For MiNERVA /rom/?name=... links, link.href is already an absolute URL —
        // preserve it as-is so the download uses the correct /rom/ endpoint.
        // For legacy relative links, resolve them against the current page URL.
        let fileHref;
        if (link.href.startsWith('http://') || link.href.startsWith('https://')) {
          fileHref = link.href;
        } else {
          const absoluteFileUrl = new URL(link.href, url).toString();
          let relativeHref = absoluteFileUrl.replace(baseUrl, '');
          if (relativeHref.startsWith('/')) {
            relativeHref = relativeHref.substring(1);
          }
          fileHref = relativeHref;
        }
        currentLevelFiles.push({ ...link, href: fileHref, type: 'file' });
      }
    });

    allRawFileLinks = [...currentLevelFiles];

    const limit = pLimit(CONCURRENCY_LIMIT);
    const subdirectoryPromises = subdirectories.map(dir =>
      limit(() => {
        const subdirectoryUrl = new URL(dir.href, url).toString();
        return this._scrapeRawFileLinks(subdirectoryUrl, baseUrl);
      })
    );

    const results = await Promise.all(subdirectoryPromises);
    results.forEach(subDirRawFileLinks => {
      allRawFileLinks = [...allRawFileLinks, ...subDirRawFileLinks];
    });

    return allRawFileLinks;
  }

  /**
   * Scrapes a given URL for file and directory links, recursively collects all files, and parses their information.
   * @memberof MyrientService
   * @param {string} url The URL of the page containing file and directory links.
   * @returns {Promise<{files: Array<object>, tags: object}|{error: string}>} A promise that resolves with an object containing
   *                                                                         parsed file information (`files`) and unique tags (`tags`)
   *                                                                         derived from the files, or an error message if the operation fails.
   */
  async scrapeAndParseFiles(url) {
    try {
      const allRawFileLinks = await this._scrapeRawFileLinks(url, url);
      const { files: parsedItems, tags: parsedTags } = this.fileParser.parseFiles(allRawFileLinks);
      return { files: parsedItems, tags: parsedTags };
    } catch (e) {
      return { error: e.message };
    }
  }
}

export default MyrientService;