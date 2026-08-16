import { describe, expect, it } from 'vitest';
import { buildChromiumEnvironment } from './chromium-environment';

describe('buildChromiumEnvironment', () => {
  it('preserves the runtime variables required by headless Linux and local headed development', () => {
    const source = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/tmp/chrome-home',
      TMPDIR: '/tmp/runtime',
      LANG: 'en_GB.UTF-8',
      LANGUAGE: 'en_GB:en',
      LC_ALL: '',
      LC_CTYPE: 'UTF-8',
      LC_MESSAGES: 'en_GB.UTF-8',
      TZ: 'Europe/London',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/tmp/xauthority',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_HOME: '/tmp/config',
      XDG_CACHE_HOME: '/tmp/cache',
      XDG_DATA_HOME: '/tmp/data',
      XDG_CONFIG_DIRS: '/etc/xdg',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
    };

    expect(buildChromiumEnvironment(source)).toEqual(source);
  });

  it('supports the environment names used to launch Chrome on Windows', () => {
    const source = {
      Path: String.raw`C:\Windows\System32`,
      USERPROFILE: String.raw`C:\Users\crawler`,
      LOCALAPPDATA: String.raw`C:\Users\crawler\AppData\Local`,
      APPDATA: String.raw`C:\Users\crawler\AppData\Roaming`,
      TEMP: String.raw`C:\Temp`,
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };

    expect(buildChromiumEnvironment(source)).toEqual(source);
  });

  it('excludes application secrets, cloud identity, job metadata, proxy settings, loader injection, and unknowns', () => {
    const environment = buildChromiumEnvironment({
      HOME: '/tmp',
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'model-secret',
      ENGINE_SHARED_SECRET: 'engine-secret',
      ENGINE_DATABASE_URL: 'postgres://secret',
      FIREBASE_RUNTIME_CONFIG: 'firebase-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/google.json',
      CLOUD_RUN_EXECUTION: 'execution-id',
      ACCRAWL_TENANT_ID: 'tenant-id',
      HTTP_PROXY: 'http://proxy.example',
      HTTPS_PROXY: 'http://proxy.example',
      ALL_PROXY: 'socks5://proxy.example',
      NO_PROXY: 'metadata.google.internal',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      LD_PRELOAD: '/tmp/inject.so',
      LD_LIBRARY_PATH: '/tmp/libraries',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
      PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers',
      CHROME_LOG_FILE: '/tmp/chrome.log',
      UNKNOWN_VARIABLE: 'unknown',
    });

    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp',
    });
  });

  it('returns a new object and does not retain later source mutations', () => {
    const source: Record<string, string | undefined> = {
      HOME: '/tmp/original',
    };

    const environment = buildChromiumEnvironment(source);
    source.HOME = '/tmp/changed';

    expect(environment).toEqual({ HOME: '/tmp/original' });
    expect(environment).not.toBe(source);
  });
});
