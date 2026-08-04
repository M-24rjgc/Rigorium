// Ensure unified YAML config is applied before reading flags.
import '../load-env.js';

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * When true, skip JWT login/register in the web UI (single-user local mode).
 *
 * Default: enabled only in desktop mode — the Electron app launches the UI
 * server on 127.0.0.1 and has no login flow. In self-hosted server mode
 * local auth is ON by default: the listener is loopback-bound by default,
 * and any LAN exposure must be an explicit choice (HOST + auth). To
 * explicitly disable auth in server mode, set RIGORIUM_DISABLE_LOCAL_AUTH=1.
 * @type {boolean}
 */
export const DISABLE_LOCAL_AUTH =
  process.env.RIGORIUM_DESKTOP === '1'
    ? process.env.RIGORIUM_DISABLE_LOCAL_AUTH !== '0' &&
      process.env.RIGORIUM_DISABLE_LOCAL_AUTH !== 'false'
    : process.env.RIGORIUM_DISABLE_LOCAL_AUTH === '1' ||
      process.env.RIGORIUM_DISABLE_LOCAL_AUTH === 'true';
