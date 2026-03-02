import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class HomePanel {
  public static currentPanel: HomePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    const iconUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png')
    );
    this._panel.webview.html = this._getLoadingHtml(iconUri.toString());
    void this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.command) {
        vscode.commands.executeCommand(msg.command);
      }
    }, null, this._disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri) {
    if (HomePanel.currentPanel) {
      HomePanel.currentPanel._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'openclawHome', 'OpenClaw Home', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
    );
    HomePanel.currentPanel = new HomePanel(panel, extensionUri);
  }

  public dispose() {
    HomePanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private async _update() {
    const openclawDir = path.join(os.homedir(), '.openclaw');
    const dirExists = fs.existsSync(openclawDir);
    const cliCheck = await this._testOpenClawCli();
    const isInstalled = dirExists && cliCheck.ok;
    const iconUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png')
    );
    this._panel.webview.html = this._getHtml(isInstalled, dirExists, cliCheck, iconUri.toString());
  }

  private _getLoadingHtml(iconUri: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { font-size: 16px; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      background: #1a1a1a;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: clamp(16px, 5vw, 48px) clamp(12px, 4vw, 32px);
      text-align: center;
    }
    .logo {
      width: clamp(56px, 14vw, 96px);
      height: clamp(56px, 14vw, 96px);
      margin-bottom: clamp(14px, 3vw, 24px);
      filter: drop-shadow(0 4px 12px rgba(220, 40, 40, 0.3));
      animation: pulse 2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; filter: drop-shadow(0 4px 12px rgba(220, 40, 40, 0.3)); }
      50% { opacity: 0.75; filter: drop-shadow(0 4px 20px rgba(220, 40, 40, 0.6)); }
    }
    h1 {
      font-size: clamp(16px, 4.5vw, 28px);
      font-weight: 700;
      margin-bottom: clamp(4px, 1vw, 8px);
      color: #fff;
      line-height: 1.2;
      word-break: break-word;
    }
    h1 .accent { color: #dc2828; }
    .tagline {
      color: #888;
      font-size: clamp(11px, 2.5vw, 14px);
      margin-bottom: clamp(24px, 6vw, 40px);
      max-width: 40ch;
      line-height: 1.5;
    }
    .spinner-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: clamp(10px, 2.5vw, 16px);
    }
    .spinner {
      width: clamp(24px, 6vw, 36px);
      height: clamp(24px, 6vw, 36px);
      border: 3px solid rgba(220, 40, 40, 0.15);
      border-top-color: #dc2828;
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading-text {
      font-size: clamp(11px, 2.5vw, 13px);
      color: #666;
      letter-spacing: 0.02em;
    }
    .loading-dots::after {
      content: '';
      animation: dots 1.5s steps(4, end) infinite;
    }
    @keyframes dots {
      0%   { content: ''; }
      25%  { content: '.'; }
      50%  { content: '..'; }
      75%  { content: '...'; }
      100% { content: ''; }
    }
  </style>
</head>
<body>
  <img class="logo" src="${iconUri}" alt="OpenClaw" />
  <h1>Welcome to <span class="accent">OpenClaw</span> Code</h1>
  <p class="tagline">AI powered local installation and management tool for OpenClaw.</p>
  <div class="spinner-wrap">
    <div class="spinner"></div>
    <span class="loading-text">Checking environment<span class="loading-dots"></span></span>
  </div>
</body>
</html>`;
  }

  private _getHtml(
    isInstalled: boolean,
    dirExists: boolean,
    cliCheck: { ok: boolean; output?: string; error?: string; command: string },
    iconUri: string
  ): string {
    const statusIcon = isInstalled ? '✅' : '⚠️';
    const statusText = isInstalled ? 'OpenClaw detected' : 'OpenClaw not found';
    const statusClass = isInstalled ? 'detected' : 'not-found';
    const buttonLabel = isInstalled ? 'Configure OpenClaw' : 'Install OpenClaw';
    const buttonCommand = isInstalled ? 'openclaw.configure' : 'openclaw.install';
    const dirText = dirExists ? 'found' : 'missing';
    const dirClass = dirExists ? 'ok' : 'warn';
    const cliText = cliCheck.ok ? (cliCheck.output || 'ok') : (cliCheck.output || cliCheck.error || 'not found');
    const cliClass = cliCheck.ok ? 'ok' : 'warn';
    const cliHint = cliCheck.ok ? '' : ` (tried: ${cliCheck.command})`;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { font-size: 16px; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      background: #1a1a1a;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: clamp(16px, 5vw, 48px) clamp(12px, 4vw, 32px);
      text-align: center;
    }

    /* ── Hero ──────────────────────────────────────────────────── */
    .logo {
      width: clamp(56px, 14vw, 96px);
      height: clamp(56px, 14vw, 96px);
      margin-bottom: clamp(12px, 3vw, 24px);
      filter: drop-shadow(0 4px 12px rgba(220, 40, 40, 0.3));
      flex-shrink: 0;
    }
    h1 {
      font-size: clamp(15px, 4.5vw, 28px);
      font-weight: 700;
      margin-bottom: clamp(4px, 1vw, 8px);
      color: #fff;
      line-height: 1.2;
      word-break: break-word;
    }
    h1 .accent { color: #dc2828; }
    .tagline {
      color: #888;
      font-size: clamp(11px, 2.5vw, 14px);
      margin-bottom: clamp(18px, 5vw, 32px);
      max-width: 44ch;
      line-height: 1.5;
    }

    /* ── Status badge ──────────────────────────────────────────── */
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: clamp(11px, 2.5vw, 14px);
      margin-bottom: clamp(16px, 4vw, 28px);
      padding: clamp(5px, 1.5vw, 8px) clamp(10px, 3vw, 16px);
      border-radius: 6px;
      background: rgba(255,255,255,0.04);
      max-width: 95vw;
    }
    .status.detected { color: #4ade80; }
    .status.not-found { color: #facc15; }

    /* ── Checks card ───────────────────────────────────────────── */
    .checks {
      width: min(520px, 96vw);
      background: rgba(255,255,255,0.03);
      border: 1px solid #2b2b2b;
      border-radius: 8px;
      padding: clamp(8px, 2.5vw, 12px) clamp(10px, 3vw, 16px);
      margin-bottom: clamp(16px, 4vw, 24px);
      font-size: clamp(11px, 2.5vw, 13px);
    }
    .check-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      padding: clamp(4px, 1.2vw, 6px) 0;
      border-bottom: 1px solid #2b2b2b;
    }
    .check-row:last-child { border-bottom: none; }
    .check-row .label {
      color: #9a9a9a;
      text-align: left;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .check-row .value {
      flex: 0 0 auto;
      text-align: right;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .check-row .value.ok { color: #4ade80; }
    .check-row .value.warn { color: #facc15; }

    /* ── Buttons ───────────────────────────────────────────────── */
    .btn-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: clamp(8px, 2vw, 12px);
      width: min(320px, 96vw);
    }
    .btn-primary {
      background: #dc2828;
      color: #fff;
      border: none;
      padding: clamp(9px, 2.5vw, 12px) clamp(18px, 5vw, 28px);
      border-radius: 8px;
      font-size: clamp(13px, 3vw, 15px);
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      width: fit-content;
      white-space: nowrap;
    }
    .btn-primary:hover { background: #b91c1c; }
    .btn-primary:active { transform: scale(0.98); }
    .btn-secondary {
      background: transparent;
      color: #aaa;
      border: 1px solid #444;
      padding: clamp(7px, 2vw, 10px) clamp(14px, 4vw, 20px);
      border-radius: 8px;
      font-size: clamp(11px, 2.5vw, 13px);
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, transform 0.1s;
      width: fit-content;
      white-space: nowrap;
    }
    .btn-secondary:hover { border-color: #888; color: #ddd; }
    .btn-secondary:active { transform: scale(0.98); }

    /* ── Footer links ──────────────────────────────────────────── */
    .links {
      margin-top: clamp(28px, 7vw, 48px);
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: clamp(12px, 3vw, 24px);
    }
    .links a {
      color: #666;
      text-decoration: none;
      font-size: clamp(10px, 2vw, 12px);
      transition: color 0.15s;
      white-space: nowrap;
    }
    .links a:hover { color: #dc2828; }

    /* ── Narrow panel adjustments (< 300px) ────────────────────── */
    @media (max-width: 299px) {
      .check-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      .check-row .label,
      .check-row .value {
        max-width: 100%;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
      }
    }
  </style>
</head>
<body>
  <img class="logo" src="${iconUri}" alt="OpenClaw" />
  <h1>Welcome to <span class="accent">OpenClaw</span> Code</h1>
  <p class="tagline">AI powered local installation for OpenClaw</p>
  <div class="status ${statusClass}">${statusIcon} ${statusText}</div>
  <div class="checks">
    <div class="check-row">
      <span class="label">Config folder (~/.openclaw)</span>
      <span class="value ${dirClass}">${dirText}</span>
    </div>
    <div class="check-row">
      <span class="label">CLI (openclaw --version)</span>
      <span class="value ${cliClass}">${cliText}${cliHint}</span>
    </div>
  </div>
  <div class="btn-group">
    <button class="btn-primary" onclick="cmd('${buttonCommand}')">${buttonLabel}</button>
    <button class="btn-secondary" onclick="cmd('openclaw.status')">Check Status</button>
  </div>
  <div class="links">
    <a href="https://github.com/damoahdominic/occ">GitHub</a>
    <a href="https://openclaw.ai">Website</a>
    <a href="https://docs.openclaw.ai">Docs</a>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function cmd(c) { vscode.postMessage({ command: c }); }
  </script>
</body>
</html>`;
  }

  private async _testOpenClawCli(): Promise<{ ok: boolean; output?: string; error?: string; command: string }> {
    if (process.platform === 'win32') {
      // ── 1. Find openclaw.mjs (checks npm prefix + version-manager paths) ──────
      const mjs = await this._findWindowsOpenClawMjs();
      if (mjs) {
        // ── 2. Find node.exe (PATH-first, then nvm/Volta/scoop, then hardcoded) ──
        const nodeExe = await this._findWindowsNodeExe();
        if (nodeExe) {
          return this._spawnNodeMjs(nodeExe, mjs, `"${nodeExe}" "${mjs}" --version`);
        }
      }

      // ── 3. .cmd / .exe shim fallback (npm prefix + scoop shims) ──────────────
      const cmdPath = await this._findWindowsOpenClawCmd();
      if (cmdPath) {
        return new Promise(resolve => {
          cp.execFile(
            'cmd.exe', ['/c', cmdPath, '--version'],
            { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error) {
                const timedOut = (error as any).signal === 'SIGTERM' || error.code == null;
                resolve({
                  ok: false,
                  error: timedOut ? 'Timed out' : (stderr?.toString().trim() || `Exit ${error.code}`),
                  command: `${cmdPath} --version`,
                });
              } else {
                resolve({ ok: true, output: (stdout || stderr || '').toString().trim(), command: `${cmdPath} --version` });
              }
            }
          );
        });
      }

      return { ok: false, error: 'openclaw not found', command: 'openclaw --version' };
    }

    // ── Mac / Linux ──────────────────────────────────────────────────────────────
    const cliPath = await this._findOpenClawPath();
    if (!cliPath) {
      return { ok: false, error: 'openclaw not found', command: 'openclaw --version' };
    }
    return new Promise(resolve => {
      cp.execFile(
        cliPath, ['--version'],
        { timeout: 30000, maxBuffer: 1024 * 1024, env: this._buildExecEnv() },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, error: stderr?.toString().trim() || error.message || `Exit ${(error as any).code}`, command: `${cliPath} --version` });
          } else {
            resolve({ ok: true, output: (stdout || stderr || '').toString().trim(), command: `${cliPath} --version` });
          }
        }
      );
    });
  }

  /**
   * Finds openclaw.mjs in the npm global prefix (dynamic) and common
   * version-manager install paths so any Node setup is covered.
   */
  private async _findWindowsOpenClawMjs(): Promise<string | undefined> {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

    // Ask npm where its global prefix lives — covers custom prefixes / nvm / fnm
    const prefixResult = await this._runCommand('npm config get prefix', 3000);
    const npmPrefix = (prefixResult.stdout || '').trim().replace(/['"]/g, '');

    const candidates = [
      npmPrefix ? path.join(npmPrefix, 'node_modules', 'openclaw', 'openclaw.mjs') : '',
      path.join(appData, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
      // scoop (nodejs / nodejs-lts)
      path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node_modules', 'openclaw', 'openclaw.mjs'),
      path.join(home, 'scoop', 'apps', 'nodejs-lts', 'current', 'node_modules', 'openclaw', 'openclaw.mjs'),
      // Volta
      path.join(localAppData, 'Volta', 'tools', 'image', 'packages', 'openclaw', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    ].filter(Boolean);

    return candidates.find(p => fs.existsSync(p));
  }

  /**
   * Finds the real node.exe for Windows.
   * Strategy: PATH lookup first (handles nvm-windows, fnm, Volta shims, winget,
   * and standard installs), then version-manager directories, then hardcoded paths.
   */
  private async _findWindowsNodeExe(): Promise<string | undefined> {
    const home = os.homedir();
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

    // 1. PATH lookup — most reliable; works for nvm-windows, fnm, Volta shims,
    //    winget, and standard installers without any special-casing.
    try {
      const found = await new Promise<string>((resolve, reject) =>
        cp.exec('where node.exe', { timeout: 3000, windowsHide: true }, (err, stdout) =>
          err ? reject(err) : resolve(stdout.trim().split(/\r?\n/)[0]?.trim() || '')
        )
      );
      // Skip if the path belongs to VSCodium / VS Code / Electron (wrong node)
      if (found && fs.existsSync(found) && !/vscodium|vscode|electron/i.test(found)) {
        return found;
      }
    } catch {}

    // 2. nvm-windows — %NVM_HOME%\<version>\node.exe
    const nvmHome = process.env.NVM_HOME;
    if (nvmHome && fs.existsSync(nvmHome)) {
      try {
        const versions = fs.readdirSync(nvmHome)
          .filter(e => /^\d+\.\d+\.\d+$/.test(e))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions.slice(0, 5)) {
          const p = path.join(nvmHome, v, 'node.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch {}
    }

    // 3. Volta — %LOCALAPPDATA%\Volta\tools\image\node\<version>\node.exe
    const voltaNodeDir = path.join(localAppData, 'Volta', 'tools', 'image', 'node');
    if (fs.existsSync(voltaNodeDir)) {
      try {
        const versions = fs.readdirSync(voltaNodeDir)
          .filter(e => /^\d+\.\d+\.\d+$/.test(e))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions.slice(0, 5)) {
          const p = path.join(voltaNodeDir, v, 'node.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch {}
    }

    // 4. scoop (nodejs / nodejs-lts)
    for (const app of ['nodejs', 'nodejs-lts']) {
      const p = path.join(home, 'scoop', 'apps', app, 'current', 'node.exe');
      if (fs.existsSync(p)) return p;
    }

    // 5. Standard installer, chocolatey, winget fallbacks
    const hardcoded = [
      path.join(programFiles, 'nodejs', 'node.exe'),
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\node.exe',
      'C:\\tools\\nodejs\\node.exe',
    ];
    return hardcoded.find(p => fs.existsSync(p));
  }

  /**
   * Finds openclaw.cmd / .exe shim using the npm global prefix (dynamic)
   * and common fallback locations including scoop shims.
   */
  private async _findWindowsOpenClawCmd(): Promise<string | undefined> {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

    const prefixResult = await this._runCommand('npm config get prefix', 3000);
    const npmPrefix = (prefixResult.stdout || '').trim().replace(/['"]/g, '');

    const candidates = [
      npmPrefix ? path.join(npmPrefix, 'openclaw.cmd') : '',
      npmPrefix ? path.join(npmPrefix, 'openclaw.exe') : '',
      path.join(appData, 'npm', 'openclaw.cmd'),
      path.join(appData, 'npm', 'openclaw.exe'),
      // scoop shims
      path.join(home, 'scoop', 'shims', 'openclaw.cmd'),
      path.join(home, 'scoop', 'shims', 'openclaw.exe'),
    ].filter(Boolean);

    return candidates.find(p => fs.existsSync(p));
  }

  /** Spawns `<nodeExe> <mjs> --version` and resolves with the result. */
  private _spawnNodeMjs(
    nodeExe: string,
    mjs: string,
    display: string
  ): Promise<{ ok: boolean; output?: string; error?: string; command: string }> {
    return new Promise(resolve => {
      const child = cp.spawn(nodeExe, [mjs, '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', d => (stdout += d));
      child.stderr?.on('data', d => (stderr += d));
      const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGTERM' || code === null) {
          resolve({ ok: false, error: 'Timed out after 30s', command: display });
        } else if (code !== 0) {
          resolve({ ok: false, error: stderr.trim() || `Exit ${code}`, command: display });
        } else {
          resolve({ ok: true, output: (stdout || stderr).trim(), command: display });
        }
      });
      child.on('error', err => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, command: display });
      });
    });
  }

  private async _findOpenClawPath(): Promise<string | undefined> {
    const cfgPath = vscode.workspace.getConfiguration('openclaw').get<string>('cliPath');
    if (cfgPath && fs.existsSync(cfgPath)) return cfgPath;

    const envPath = process.env.OPENCLAW_CLI;
    if (envPath && fs.existsSync(envPath)) return envPath;

    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const candidates = [
        path.join(appData, 'npm', 'openclaw.cmd'),
        path.join(appData, 'npm', 'openclaw.exe'),
        path.join(appData, 'npm', 'openclaw.bat'),
        path.join(appData, 'npm', 'openclaw.ps1'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    if (process.platform === 'win32') {
      for (const probe of ['openclaw.cmd', 'openclaw.exe', 'openclaw.bat', 'openclaw.ps1', 'openclaw']) {
        const result = await this._runCommand(`where ${probe}`, 2000);
        if (!result.error && !result.notFound) {
          const out = (result.stdout || '').trim();
          if (out) {
            const candidates = out
              .split(/\r?\n/)
              .map(l => l.trim().replace(/^"+|"+$/g, ''))
              .filter(Boolean);
            for (const candidate of candidates) {
              const resolved = this._resolveWindowsCliPath(candidate);
              if (fs.existsSync(resolved)) return resolved;
            }
          }
        }
      }
    } else {
      const result = await this._runCommand('which openclaw', 2000);
      if (!result.error && !result.notFound) {
        const out = (result.stdout || '').trim();
        if (out) {
          const candidates = out
            .split(/\r?\n/)
            .map(l => l.trim().replace(/^"+|"+$/g, ''))
            .filter(Boolean);
          for (const candidate of candidates) {
            const resolved = this._resolveWindowsCliPath(candidate);
            if (fs.existsSync(resolved)) return resolved;
          }
        }
      }
    }

    const npmCandidates = await this._getNpmGlobalCliCandidates();
    for (const candidate of npmCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    const fallback = this._getCandidateCliPaths();
    for (const candidate of fallback) {
      if (fs.existsSync(candidate)) return candidate;
    }

    return undefined;
  }

  private _getCandidateCliPaths(): string[] {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      return [
        path.join(appData, 'npm', 'openclaw.cmd'),
        path.join(appData, 'npm', 'openclaw.exe'),
        path.join(appData, 'npm', 'openclaw.bat'),
        path.join(appData, 'npm', 'openclaw.ps1'),
        path.join(localAppData, 'Programs', 'OpenClaw', 'openclaw.exe'),
        path.join(localAppData, 'OpenClaw', 'openclaw.exe'),
        path.join(programFiles, 'OpenClaw', 'openclaw.exe'),
        path.join(programFiles, 'OpenClaw', 'bin', 'openclaw.exe'),
        path.join(localAppData, 'Microsoft', 'WindowsApps', 'openclaw.exe'),
        path.join(home, '.openclaw', 'bin', 'openclaw.exe'),
      ];
    }
    return [
      '/usr/local/bin/openclaw',
      '/opt/homebrew/bin/openclaw',
      path.join(home, '.local', 'bin', 'openclaw'),
      path.join(home, '.npm-global', 'bin', 'openclaw'),
      path.join(home, '.openclaw', 'bin', 'openclaw'),
    ];
  }

  private async _getNpmGlobalCliCandidates(): Promise<string[]> {
    const result = await this._runCommand('npm config get prefix', 2000);
    const prefix = (result.stdout || '').trim();
    if (!prefix) return [];
    if (process.platform === 'win32') {
      const base = this._resolveWindowsCliPath(path.join(prefix, 'openclaw'));
      return [
        `${base}.cmd`,
        `${base}.exe`,
        `${base}.bat`,
        `${base}.ps1`,
        base,
      ];
    }
    return [path.join(prefix, 'bin', 'openclaw')];
  }

  private _resolveWindowsCliPath(candidate: string) {
    if (process.platform !== 'win32') return candidate;
    const cleaned = candidate.replace(/^"+|"+$/g, '');
    if (fs.existsSync(cleaned)) return cleaned;
    if (path.extname(cleaned)) return cleaned;
    const exts = ['.cmd', '.exe', '.bat', '.ps1'];
    for (const ext of exts) {
      const withExt = `${cleaned}${ext}`;
      if (fs.existsSync(withExt)) return withExt;
    }
    return cleaned;
  }

  private _getPreferredWindowsCmdPath(candidate: string | undefined) {
    if (process.platform !== 'win32') return candidate;
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const shim = path.join(appData, 'npm', 'openclaw.cmd');
    if (fs.existsSync(shim)) return shim;
    return candidate;
  }

  private _runCommand(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; error?: string; notFound?: boolean }> {
    const env = this._buildExecEnv();
    return new Promise(resolve => {
      cp.exec(
        cmd,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env },
        (error, stdout, stderr) => {
          const result = { stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' } as {
            stdout: string;
            stderr: string;
            error?: string;
            notFound?: boolean;
          };
          if (error) {
            result.error = error.message || 'Command failed';
            const text = `${result.stderr}\n${result.error}`.toLowerCase();
            result.notFound =
              (error as any).code === 'ENOENT' ||
              text.includes('not recognized as an internal or external command') ||
              text.includes('command not found');
          }
          resolve(result);
        }
      );
    });
  }

  private _buildExecEnv() {
    const env = { ...process.env };
    const basePath = env.PATH || (env as any).Path || '';
    const extra: string[] = [];
    if (process.platform === 'win32') {
      const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      if (appData) extra.push(path.join(appData, 'npm'));
      if (env.ProgramFiles) extra.push(path.join(env.ProgramFiles, 'nodejs'));
      if (env.LOCALAPPDATA) extra.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
      const systemRoot = env.SystemRoot || (env as any).WINDIR;
      if (systemRoot) extra.push(path.join(systemRoot, 'System32'));
    } else {
      extra.push('/usr/local/bin', '/opt/homebrew/bin');
      extra.push(path.join(os.homedir(), '.local', 'bin'));
      extra.push(path.join(os.homedir(), '.npm-global', 'bin'));
      extra.push(path.join(os.homedir(), '.openclaw', 'bin'));
    }
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = [...extra, basePath].filter(Boolean).join(sep);
    (env as any).Path = env.PATH;
    return env;
  }
}
