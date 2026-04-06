import axios from 'axios';
import { compareVersions } from '../../shared/utils/versions.js';

const DEFAULT_GITHUB_OWNER = 'yeetbot90';
const DEFAULT_GITHUB_REPO = 'MiNERVA-downloader';

/**
 * Manages checking for application updates by interacting with the GitHub API.
 * Compares the current application version with the latest available release.
 * @class
 */
class UpdateManager {
    /**
     * Creates an instance of UpdateManager.
     * @param {string} appVersion The current version of the application.
     */
    constructor(appVersion) {
        this.appVersion = appVersion;
        this.githubOwner = process.env.MINERVA_UPDATE_OWNER || DEFAULT_GITHUB_OWNER;
        this.githubRepo = process.env.MINERVA_UPDATE_REPO || DEFAULT_GITHUB_REPO;
    }

    /**
     * Checks for a new application update by querying the GitHub API for the latest release.
     * @memberof UpdateManager
     * @returns {Promise<{isUpdateAvailable: boolean, latestVersion: string, releaseNotes: string, releaseUrl: string}|{error: string}>}
     * A promise that resolves with update information or an error message if the check fails.
     */
    async checkForUpdates() {
        try {
            const apiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/releases/latest`;
            const response = await axios.get(apiUrl);
            const latestVersion = response.data.tag_name.replace(/^v/i, '');
            return {
                isUpdateAvailable: compareVersions(latestVersion, this.appVersion) > 0,
                latestVersion,
                releaseNotes: response.data.body,
                releaseUrl: response.data.html_url,
            };
        } catch (error) {
            const isNotFound = error?.response?.status === 404;
            if (isNotFound) {
                return this.checkForUpdatesFromTags();
            }
            return { error: 'Could not check for updates.' };
        }
    }

    /**
     * Fallback update check using repository tags when no GitHub release exists.
     * @memberof UpdateManager
     * @returns {Promise<{isUpdateAvailable: boolean, latestVersion: string, releaseNotes: string, releaseUrl: string}|{error: string}>}
     */
    async checkForUpdatesFromTags() {
        try {
            const tagsApiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/tags?per_page=100`;
            const response = await axios.get(tagsApiUrl);
            const tags = Array.isArray(response.data) ? response.data : [];
            const parsedVersions = tags
                .map((tag) => ({
                    version: String(tag.name || '').replace(/^v/i, ''),
                    tagName: tag.name,
                }))
                .filter((entry) => /^\d+\.\d+\.\d+/.test(entry.version));

            if (!parsedVersions.length) {
                return { error: 'Could not check for updates.' };
            }

            const latest = parsedVersions.reduce((best, candidate) => (
                !best || compareVersions(candidate.version, best.version) > 0 ? candidate : best
            ), null);

            return {
                isUpdateAvailable: compareVersions(latest.version, this.appVersion) > 0,
                latestVersion: latest.version,
                releaseNotes: 'No GitHub release notes are available for this version yet.',
                releaseUrl: `https://github.com/${this.githubOwner}/${this.githubRepo}/releases`,
            };
        } catch {
            return { error: 'Could not check for updates.' };
        }
    }

    /**
     * Returns the current version of the application.
     * @memberof UpdateManager
     * @returns {string} The application version.
     */
    getAppVersion() {
        return this.appVersion;
    }
}

export default UpdateManager;
