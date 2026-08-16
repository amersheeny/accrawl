/**
 * Build the complete environment inherited by the Chromium process.
 *
 * The engine process holds bank credentials, cloud credentials, model API keys,
 * crawl ownership metadata, and database connection strings. Chromium renders
 * attacker-influenceable pages, so inheriting process.env would unnecessarily
 * expose all of those values to the browser process and its descendants.
 *
 * Keep this list limited to operating-system facilities Chromium needs:
 * filesystem locations, locale/timezone selection, and the display-session
 * coordinates required by headed local development. In particular, do not add
 * cloud/runtime metadata, proxy variables, dynamic-loader variables, browser
 * configuration variables, or application-specific variables here.
 */
const CHROMIUM_ENVIRONMENT_ALLOWLIST = [
  // Executable lookup and the browser's per-user filesystem root.
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',

  // Temporary files.
  'TMPDIR',
  'TMP',
  'TEMP',

  // Locale and timezone.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',

  // Linux desktop/session paths. DISPLAY/WAYLAND_DISPLAY/XAUTHORITY make
  // HEADLESS=false work during local development; they are normally absent
  // from the production headless worker.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',

  // Windows process startup.
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
] as const;

export type ChromiumEnvironmentSource = Readonly<
  Record<string, string | undefined>
>;

/**
 * Return a fresh, allowlisted environment without mutating or retaining the
 * supplied source. Undefined values are omitted; defined empty values are
 * preserved because they can be meaningful to the operating system.
 */
export function buildChromiumEnvironment(
  source: ChromiumEnvironmentSource,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const name of CHROMIUM_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }

  return environment;
}
