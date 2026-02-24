import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { DOWNLOAD_DIRECTORY_STRUCTURE } from '../../shared/constants/appConstants.js';

/**
 * Service responsible for file system interactions, particularly for managing download directories.
 * It provides utilities for calculating file paths, checking extraction status, and analyzing directory structures.
 * @class
 */
class FileSystemService {
  /**
   * Calculates the target and extraction paths for a file based on provided download options.
   * This static method determines where a file should be saved and where it should be extracted.
   *
   * @memberof FileSystemService
   * @param {string} baseDir The base download directory chosen by the user (e.g., 'C:\Downloads').
   * @param {object} fileInfo Information about the file to be downloaded.
   * @param {string} fileInfo.name The name of the file (e.g., 'Game (USA).zip').
   * @param {string} [fileInfo.href] The full URL of the file, used for maintaining folder structure.
   * @param {object} options Download options that influence path calculation.
   * @param {boolean} options.createSubfolder Whether to create a subfolder within `baseDir` named after the file (e.g., 'C:\Downloads\Game (USA)\Game (USA).zip').
   * @param {boolean} options.maintainFolderStructure Whether to preserve the remote folder structure within the target directory (e.g., 'C:\Downloads\Emulator\ROMs\Game.zip').
   * @param {string} options.baseUrl The base URL of the source, used with `maintainFolderStructure` to determine relative paths.
   * @returns {{targetPath: string, extractPath: string}} An object containing:
   *   - `targetPath`: The full absolute path where the downloaded file should be saved.
   *   - `extractPath`: The full absolute path where the contents of an archive file should be extracted.
   */
  static calculatePaths(baseDir, fileInfo, { createSubfolder, maintainFolderStructure, baseUrl }) {
    const filename = fileInfo.name;
    let finalTargetDir = baseDir;

    if (createSubfolder) {
      finalTargetDir = path.join(baseDir, path.parse(filename).name);
    }

    let targetPath;
    if (maintainFolderStructure && fileInfo.href) {
      let relativePath = fileInfo.href;
      try {
        const hrefUrl = new URL(fileInfo.href);
        const baseUrlObj = new URL(baseUrl);
        let hrefPath = hrefUrl.pathname;
        let basePath = baseUrlObj.pathname;
        basePath = basePath.replace(/\/$/, '');
        const basePathSegments = basePath.split('/').filter(s => s.length > 0);
        const selectedDirectory = basePathSegments[basePathSegments.length - 1];
        const parentPath = basePath.substring(0, basePath.lastIndexOf('/' + selectedDirectory));

        if (parentPath && hrefPath.startsWith(parentPath + '/')) {
          relativePath = hrefPath.substring(parentPath.length + 1);
        } else if (hrefPath.startsWith(basePath + '/')) {
          relativePath = selectedDirectory + '/' + hrefPath.substring(basePath.length + 1);
        } else {
          relativePath = filename;
        }
        relativePath = decodeURIComponent(relativePath);
      } catch (e) {
        if (relativePath.startsWith(baseUrl)) {
          relativePath = relativePath.substring(baseUrl.length);
        }
        relativePath = relativePath.replace(/^\/+/, '');
      }

      const hrefDirPath = path.dirname(relativePath);
      if (hrefDirPath && hrefDirPath !== '.' && hrefDirPath !== '/') {
        const normalizedDirPath = hrefDirPath.replace(/\//g, path.sep);
        const fullDirPath = path.join(finalTargetDir, normalizedDirPath);
        targetPath = path.join(fullDirPath, filename);
      } else {
        targetPath = path.join(finalTargetDir, filename);
      }
    } else {
      targetPath = path.join(finalTargetDir, filename);
    }

    let extractPath;
    if (maintainFolderStructure) {
      extractPath = path.dirname(targetPath);
    } else if (createSubfolder) {
      extractPath = path.join(baseDir, path.parse(filename).name);
    } else {
      extractPath = baseDir;
    }

    return { targetPath, extractPath };
  }

  /**
   * Checks if an archive's contents appear to have already been extracted to a specified path.
   * This is a heuristic check based on directory existence and content.
   *
   * @memberof FileSystemService
   * @param {string} extractionPath The directory path where the archive's contents are expected to be extracted.
   * @param {string} archiveFilename The full filename of the archive (e.g., 'Game (USA).zip').
   * @param {Date} [remoteLastModified=null] The 'Last-Modified' date of the remote archive file.
   * @returns {Promise<boolean>} A promise that resolves to `true` if the content appears to be extracted (based on heuristics), otherwise `false`.
   */
  static async isAlreadyExtracted(extractionPath, archiveFilename, remoteLastModified = null) {
    try {
      const archiveBaseName = path.parse(archiveFilename).name;

      const entries = await fs.promises.readdir(extractionPath);

      const matchingEntry = entries.find(entry => {
        const entryBaseName = path.parse(entry).name;
        return entryBaseName.toLowerCase() === archiveBaseName.toLowerCase();
      });

      if (!matchingEntry) {
        return false;
      }

      const fullPathToMatchingEntry = path.join(extractionPath, matchingEntry);
      const localStats = fs.statSync(fullPathToMatchingEntry);

      if (!remoteLastModified) {
        return true;
      }

      const localSeconds = Math.floor(localStats.mtime.getTime() / 1000);
      const remoteSeconds = Math.floor(remoteLastModified.getTime() / 1000);

      return localSeconds === remoteSeconds;
    } catch (e) {
      return false;
    }
  }

  /**
   * Checks the structure of a given download directory to determine if it's empty, flat, has subfolders, or is mixed.
   * @memberof FileSystemService
   * @param {string} downloadPath The absolute path to the download directory.
   * @returns {Promise<DOWNLOAD_DIRECTORY_STRUCTURE>} A promise that resolves with the detected directory structure enum value.
   *   Possible values are `DOWNLOAD_DIRECTORY_STRUCTURE.EMPTY`, `FLAT`, `SUBFOLDERS`, or `MIXED`.
   * @throws {Error} If an error occurs during file system access, other than the directory not existing (`ENOENT`).
   */
  static async checkDownloadDirectoryStructure(downloadPath) {
    try {
      const entries = await fs.promises.readdir(downloadPath, { withFileTypes: true });

      let hasFiles = false;
      let hasDirectories = false;

      for (const entry of entries) {
        if (entry.isFile()) {
          hasFiles = true;
        } else if (entry.isDirectory()) {
          hasDirectories = true;
        }
      }

      if (!hasFiles && !hasDirectories) {
        return DOWNLOAD_DIRECTORY_STRUCTURE.EMPTY;
      } else if (hasFiles && !hasDirectories) {
        return DOWNLOAD_DIRECTORY_STRUCTURE.FLAT;
      } else if (!hasFiles && hasDirectories) {
        return DOWNLOAD_DIRECTORY_STRUCTURE.SUBFOLDERS;
      } else {
        return DOWNLOAD_DIRECTORY_STRUCTURE.MIXED;
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        return DOWNLOAD_DIRECTORY_STRUCTURE.EMPTY; // Directory does not exist, consider it empty
      }
      throw e; // Re-throw other file system errors
    }
  }
}

export default FileSystemService;
