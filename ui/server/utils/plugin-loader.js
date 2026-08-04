import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawn } from 'child_process';
import { prepareCliSpawn } from './processSpawn.js';

const PLUGINS_DIR = path.join(os.homedir(), '.rigorium', 'plugins');
const PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.rigorium', 'plugins.json');

/**
 * Unified manifest v2 (see `src/extension/plugins/protocol/manifest.ts`):
 * only `name` is required. `displayName` / `entry` are UI-only, `skills` /
 * `hooks` / `settings` are gateway-only — a plugin may be either or both.
 * The gateway side reads the same manifest (plugin.json first, manifest.json
 * fallback), so one installed plugin contributes to both surfaces.
 */
const REQUIRED_MANIFEST_FIELDS = ['name'];

/** Strip embedded credentials from a repo URL before exposing it to the client. */
function sanitizeRepoUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL (e.g. SSH shorthand) — strip user:pass@ segment
    return raw.replace(/\/\/[^@/]+@/, '//');
  }
}
const ALLOWED_TYPES = ['react', 'module'];
const ALLOWED_SLOTS = ['tab'];

export function getPluginsDir() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }
  return PLUGINS_DIR;
}

export function getPluginsConfig() {
  try {
    if (fs.existsSync(PLUGINS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGINS_CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted config, start fresh
  }
  return {};
}

export function savePluginsConfig(config) {
  const dir = path.dirname(PLUGINS_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PLUGINS_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  // Sanitize name — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) {
    return { valid: false, error: 'Plugin name must only contain letters, numbers, hyphens, and underscores' };
  }

  if (manifest.type && !ALLOWED_TYPES.includes(manifest.type)) {
    return { valid: false, error: `Invalid plugin type: ${manifest.type}. Must be one of: ${ALLOWED_TYPES.join(', ')}` };
  }

  if (manifest.slot && !ALLOWED_SLOTS.includes(manifest.slot)) {
    return { valid: false, error: `Invalid plugin slot: ${manifest.slot}. Must be one of: ${ALLOWED_SLOTS.join(', ')}` };
  }

  // Validate entry is a relative path without traversal (UI-only field —
  // a pure gateway plugin has no entry and must not be rejected).
  if (manifest.entry !== undefined && manifest.entry !== null) {
    if (typeof manifest.entry !== 'string' || manifest.entry.includes('..') || path.isAbsolute(manifest.entry)) {
      return { valid: false, error: 'Entry must be a relative path without ".."' };
    }
  }

  if (manifest.server !== undefined && manifest.server !== null) {
    if (typeof manifest.server !== 'string' || manifest.server.includes('..') || path.isAbsolute(manifest.server)) {
      return { valid: false, error: 'Server entry must be a relative path string without ".."' };
    }
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || !manifest.permissions.every(p => typeof p === 'string')) {
      return { valid: false, error: 'Permissions must be an array of strings' };
    }
  }

  return { valid: true };
}

const BUILD_TIMEOUT_MS = 60_000;

/** Run `npm run build` if the plugin's package.json declares a build script. */
function runBuildIfNeeded(dir, packageJsonPath, onSuccess, onError) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg.scripts?.build) {
      return onSuccess();
    }
  } catch {
    return onSuccess(); // Unreadable package.json — skip build
  }

  const buildSpawn = prepareCliSpawn('npm', ['run', 'build'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const buildProcess = spawn(buildSpawn.command, buildSpawn.args, buildSpawn.options);

  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    buildProcess.removeAllListeners();
    buildProcess.kill();
    onError(new Error('npm run build timed out'));
  }, BUILD_TIMEOUT_MS);

  buildProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  buildProcess.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      return onError(new Error(`npm run build failed (exit code ${code}): ${stderr.trim()}`));
    }
    onSuccess();
  });

  buildProcess.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onError(new Error(`Failed to spawn build: ${err.message}`));
  });
}

export function scanPlugins() {
  const pluginsDir = getPluginsDir();
  const config = getPluginsConfig();
  const plugins = [];

  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return plugins;
  }

  const seenNames = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip transient temp directories from in-progress installs
    if (entry.name.startsWith('.tmp-')) continue;

    // Unified manifest v2: read `plugin.json` (new) or `manifest.json` (legacy).
    const manifestPath = findPluginManifest(path.join(pluginsDir, entry.name));
    if (!manifestPath) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const validation = validateManifest(manifest);
      if (!validation.valid) {
        console.warn(`[Plugins] Skipping ${entry.name}: ${validation.error}`);
        continue;
      }

      // Skip duplicate manifest names
      if (seenNames.has(manifest.name)) {
        console.warn(`[Plugins] Skipping ${entry.name}: duplicate plugin name "${manifest.name}"`);
        continue;
      }
      seenNames.add(manifest.name);

      // Try to read git remote URL
      let repoUrl = null;
      try {
        const gitConfigPath = path.join(pluginsDir, entry.name, '.git', 'config');
        if (fs.existsSync(gitConfigPath)) {
          const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');
          const match = gitConfig.match(/url\s*=\s*(.+)/);
          if (match) {
            repoUrl = match[1].trim().replace(/\.git$/, '');
            // Convert SSH URLs to HTTPS
            if (repoUrl.startsWith('git@')) {
              repoUrl = repoUrl.replace(/^git@([^:]+):/, 'https://$1/');
            }
            // Strip embedded credentials (e.g. https://user:pass@host/...)
            repoUrl = sanitizeRepoUrl(repoUrl);
          }
        }
      } catch { /* ignore */ }

      plugins.push({
        name: manifest.name,
        displayName: manifest.displayName || manifest.name,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        author: manifest.author || '',
        icon: manifest.icon || 'Puzzle',
        type: manifest.type || 'module',
        slot: manifest.slot || 'tab',
        // A pure gateway plugin (skills/hooks only) has no UI entry — the UI
        // lists it read-only without mounting a tab.
        entry: manifest.entry || null,
        hasUi: typeof manifest.entry === 'string' && manifest.entry.length > 0,
        server: manifest.server || null,
        permissions: manifest.permissions || [],
        // Gateway-side contributions, surfaced read-only here so the UI can
        // show what an installed plugin actually provides. `settings` is an
        // arbitrary author blob that may contain secrets — strip credential-
        // shaped keys before exposing it to the browser client.
        skills: manifest.skills || null,
        hooks: manifest.hooks || null,
        settings: sanitizePluginSettings(manifest.settings),
        enabled: config[manifest.name]?.enabled !== false, // enabled by default
        dirName: entry.name,
        repoUrl,
        commitSha: readPluginSource(entry.name)?.commitSha ?? null,
        installedAt: readPluginSource(entry.name)?.installedAt ?? null,
      });
    } catch (err) {
      console.warn(`[Plugins] Failed to read manifest for ${entry.name}:`, err.message);
    }
  }

  return plugins;
}

/** Resolve the manifest file for a plugin dir: plugin.json first, then manifest.json. */
function findPluginManifest(pluginDir) {
  const preferred = path.join(pluginDir, 'plugin.json');
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(pluginDir, 'manifest.json');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password|credential|auth[_-]?header/i;

/** Strip credential-shaped keys from an arbitrary plugin settings blob. */
function sanitizePluginSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings || null;
  }
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function getPluginDir(name) {
  const plugins = scanPlugins();
  const plugin = plugins.find(p => p.name === name);
  if (!plugin) return null;
  return path.join(getPluginsDir(), plugin.dirName);
}

export function resolvePluginAssetPath(name, assetPath) {
  const pluginDir = getPluginDir(name);
  if (!pluginDir) return null;

  const resolved = path.resolve(pluginDir, assetPath);

  // Prevent path traversal — canonicalize via realpath to defeat symlink bypasses
  if (!fs.existsSync(resolved)) return null;

  const realResolved = fs.realpathSync(resolved);
  const realPluginDir = fs.realpathSync(pluginDir);
  if (!realResolved.startsWith(realPluginDir + path.sep) && realResolved !== realPluginDir) {
    return null;
  }

  return realResolved;
}

export function installPluginFromGit(url) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || !url.trim()) {
      return reject(new Error('Invalid URL: must be a non-empty string'));
    }
    if (url.startsWith('-')) {
      return reject(new Error('Invalid URL: must not start with "-"'));
    }

    // Extract repo name from URL for directory name
    const urlClean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const repoName = urlClean.split('/').pop();

    if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) {
      return reject(new Error('Could not determine a valid directory name from the URL'));
    }

    const pluginsDir = getPluginsDir();
    const targetDir = path.resolve(pluginsDir, repoName);

    // Ensure the resolved target directory stays within the plugins directory
    if (!targetDir.startsWith(pluginsDir + path.sep)) {
      return reject(new Error('Invalid plugin directory path'));
    }

    if (fs.existsSync(targetDir)) {
      return reject(new Error(`Plugin directory "${repoName}" already exists`));
    }

    // Clone into a temp directory so scanPlugins() never sees a partially-installed plugin
    const tempDir = fs.mkdtempSync(path.join(pluginsDir, `.tmp-${repoName}-`));

    const cleanupTemp = () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    };

    const finalize = (manifest) => {
      try {
        fs.renameSync(tempDir, targetDir);
      } catch (err) {
        cleanupTemp();
        return reject(new Error(`Failed to move plugin into place: ${err.message}`));
      }
      // Supply-chain provenance: record exactly which commit was installed so
      // the user can audit what they are running (and what an update changed).
      recordPluginSource(targetDir, url);
      resolve(manifest);
    };

    const gitProcess = spawn('git', ['clone', '--depth', '1', '--', url, tempDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    let stderr = '';
    gitProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        cleanupTemp();
        return reject(new Error(`git clone failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Validate manifest exists (plugin.json or legacy manifest.json)
      const manifestPath = findPluginManifest(tempDir);
      if (!manifestPath) {
        cleanupTemp();
        return reject(new Error('Cloned repository does not contain a plugin.json or manifest.json'));
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        cleanupTemp();
        return reject(new Error(`${path.basename(manifestPath)} is not valid JSON`));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        cleanupTemp();
        return reject(new Error(`Invalid manifest: ${validation.error}`));
      }

      // Reject if another installed plugin already uses this name
      const existing = scanPlugins().find(p => p.name === manifest.name);
      if (existing) {
        cleanupTemp();
        return reject(new Error(`A plugin named "${manifest.name}" is already installed (in "${existing.dirName}")`));
      }

      // Run npm install if package.json exists.
      // --ignore-scripts prevents postinstall hooks from executing arbitrary code.
      const packageJsonPath = path.join(tempDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmSpawn = prepareCliSpawn('npm', ['install', '--ignore-scripts'], {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        });
        const npmProcess = spawn(npmSpawn.command, npmSpawn.args, npmSpawn.options);

        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            cleanupTemp();
            return reject(new Error(`npm install for ${repoName} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(tempDir, packageJsonPath, () => finalize(manifest), (err) => { cleanupTemp(); reject(err); });
        });

        npmProcess.on('error', (err) => {
          cleanupTemp();
          reject(err);
        });
      } else {
        finalize(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      cleanupTemp();
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

export function updatePluginFromGit(name) {
  return new Promise((resolve, reject) => {
    const pluginDir = getPluginDir(name);
    if (!pluginDir) {
      return reject(new Error(`Plugin "${name}" not found`));
    }

    // Only fast-forward to avoid silent divergence
    const gitProcess = spawn('git', ['pull', '--ff-only', '--'], {
      cwd: pluginDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    let stderr = '';
    gitProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`git pull failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Re-validate manifest after update
      const manifestPath = findPluginManifest(pluginDir);
      if (!manifestPath) {
        return reject(new Error('Plugin manifest missing after update'));
      }
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        return reject(new Error(`${path.basename(manifestPath)} is not valid JSON after update`));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        return reject(new Error(`Invalid manifest after update: ${validation.error}`));
      }

      recordPluginSource(pluginDir, null);

      // Re-run npm install if package.json exists
      const packageJsonPath = path.join(pluginDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmSpawn = prepareCliSpawn('npm', ['install', '--ignore-scripts'], {
          cwd: pluginDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        });
        const npmProcess = spawn(npmSpawn.command, npmSpawn.args, npmSpawn.options);
        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            return reject(new Error(`npm install for ${name} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(pluginDir, packageJsonPath, () => resolve(manifest), (err) => reject(err));
        });
        npmProcess.on('error', (err) => reject(err));
      } else {
        resolve(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

export async function uninstallPlugin(name) {
  const pluginDir = getPluginDir(name);
  if (!pluginDir) {
    throw new Error(`Plugin "${name}" not found`);
  }

  // On Windows, file handles may be released slightly after process exit.
  // Retry a few times with a short delay before giving up.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (err.code === 'EBUSY' && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }

  // Remove from config
  const config = getPluginsConfig();
  delete config[name];
  savePluginsConfig(config);
}


const PLUGIN_SOURCE_FILE = '.rigorium-source.json';

/**
 * Record which commit of a plugin is installed (supply-chain provenance).
 * Best-effort: a non-git plugin directory or a failed `git rev-parse` simply
 * leaves no record. When `url` is null the existing record's URL is kept
 * (update path).
 */
function recordPluginSource(pluginDir, url) {
  try {
    const existing = readPluginSourceFromDir(pluginDir);
    let commitSha = null;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: pluginDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch { /* not a git checkout */ }
    const record = {
      url: url || existing?.url || null,
      commitSha,
      installedAt: existing?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(pluginDir, PLUGIN_SOURCE_FILE), JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* provenance must never break install/update */ }
}

function readPluginSource(dirName) {
  try {
    return readPluginSourceFromDir(path.join(getPluginsDir(), dirName));
  } catch {
    return null;
  }
}

function readPluginSourceFromDir(pluginDir) {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, PLUGIN_SOURCE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        url: typeof parsed.url === 'string' ? parsed.url : null,
        commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : null,
        installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    }
  } catch { /* missing/corrupt — treat as absent */ }
  return null;
}
