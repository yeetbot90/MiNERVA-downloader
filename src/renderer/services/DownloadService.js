import stateService from '../StateService.js';

/**
 * Service for download-related actions.
 * @class
 */
class DownloadService {
  /**
   * Prompts the user to select a download directory and updates the state service.
   * @memberof DownloadService
   * @returns {Promise<string|null>} A promise that resolves with the selected directory path, or null if canceled.
   */
  async getDownloadDirectory() {
    const dir = await window.electronAPI.getDownloadDirectory();
    if (dir) {
      stateService.set('downloadDirectory', dir);
    }
    return dir;
  }

  /**
   * Checks the structure of the specified download directory.
   * @memberof DownloadService
   * @param {string} downloadPath The path to the download directory.
   * @returns {Promise<string>} A promise that resolves with the detected directory structure.
   * @throws {Error} If there is an error checking the directory structure.
   */
  async checkDownloadDirectoryStructure(downloadPath) {
    const result = await window.electronAPI.checkDownloadDirectoryStructure(downloadPath);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  }

  /**
   * Retrieves the DownloadDirectoryStructure enum from the main process.
   * @memberof DownloadService
   * @returns {Promise<object>} A promise that resolves with the DownloadDirectoryStructure enum.
   * @throws {Error} If there is an error retrieving the enum.
   */
  async getDownloadDirectoryStructureEnum() {
    const result = await window.electronAPI.getDownloadDirectoryStructureEnum();
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  }

  /**
   * Initiates the download process for the selected files.
   * @memberof DownloadService
   * @param {Array<object>} files An array of file objects to download. Each object should contain properties like `name`, `href`, `size`, `type`, `relativePath`.
   */
  startDownload(files) {
    const directoryStack = stateService.get('directoryStack') || [];
    const path = directoryStack.map(item => item.href).join('');
    const baseUrl = new URL(path, stateService.get('baseUrl')).href;
    const createSubfolder = stateService.get('createSubfolder');
    const maintainFolderStructure = stateService.get('maintainFolderStructure');
    const extractAndDelete = document.getElementById('extract-archives-checkbox')?.checked;
    const extractPreviouslyDownloaded = document.getElementById('extract-previously-downloaded-checkbox')?.checked;
    const forceRedownloadExtracted = document.getElementById('force-redownload-checkbox')?.checked;
    const skipScan = document.getElementById('skip-scan-checkbox').checked;
    const isThrottlingEnabled = stateService.get('isThrottlingEnabled');
    const throttleSpeed = stateService.get('throttleSpeed');
    const throttleUnit = stateService.get('throttleUnit');
    window.electronAPI.startDownload(baseUrl, files, stateService.get('downloadDirectory'), createSubfolder, maintainFolderStructure, extractAndDelete, extractPreviouslyDownloaded, skipScan, isThrottlingEnabled, throttleSpeed, throttleUnit, forceRedownloadExtracted);
  }

  /**
   * Sends a request to the main process to cancel the current download.
   */
  cancelDownload() {
    window.electronAPI.cancelDownload();
  }
}

const downloadService = new DownloadService();
export default downloadService;
