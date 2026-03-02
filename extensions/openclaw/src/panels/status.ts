import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type GatewayStatus = {
  installed: boolean;
  running: boolean;
  pid?: string;
  port?: string;
  uptime?: string;
  service?: string;
  dashboard?: string;
  probe?: string;
  logFile?: string;
  configPath?: string;
  issues?: string[];
  exitCode?: string;
  cliPath?: string;
  command?: string;
  stderr?: string;
  pathEnv?: string;
  raw: string;
  error?: string;
  updatedAt: string;
};

type RunResult = {
  stdout: string;
  stderr: string;
  code?: string;
  timedOut?: boolean;
  notFound?: boolean;
  error?: string;
  pathEnv?: string;
  command?: string;
  exitCode?: number | null;
};

export class StatusPanel {
  public static currentPanel: StatusPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _refreshing = false;
  private _refreshQueued = false;
  private _lastStatus?: GatewayStatus;
  private _lastStatusAt = 0;
  private _isVisible = true;
  private _gatewayTerminal?: vscode.Terminal;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._isVisible = panel.visible;
    this._panel.webview.html = this._getLoadingHtml();
    void this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState(e => {
      this._isVisible = e.webviewPanel.visible;
      if (this._isVisible) {
        void this._update();
      }
    }, null, this._disposables);
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') {
        if (!this._isVisible) return;
        void this._update();
      } else if (msg.command === 'gateway-start') {
        void this._runGateway('start');
      } else if (msg.command === 'gateway-stop') {
        void this._runGateway('stop');
      } else if (msg.command === 'gateway-restart') {
        void this._runGateway('restart');
      } else if (msg.command === 'install') {
        vscode.commands.executeCommand('openclaw.install');
      } else if (msg.command === 'configure') {
        vscode.commands.executeCommand('openclaw.configure');
      } else if (msg.command === 'open-dashboard' && msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.command === 'open-logs' && msg.path) {
        let p = msg.path as string;
        if (process.platform === 'win32' && !/^[a-zA-Z]:/.test(p) && /^[\\/]/.test(p)) {
          const drive = process.env.SystemDrive || 'C:';
          p = `${drive}${p}`;
        }
        const uri = vscode.Uri.file(p);
        vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
      }
    }, null, this._disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri) {
    if (StatusPanel.currentPanel) {
      StatusPanel.currentPanel._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'openclawStatus', 'OpenClaw Status', vscode.ViewColumn.One,
      { enableScripts: true }
    );
    StatusPanel.currentPanel = new StatusPanel(panel);
  }

  public dispose() {
    StatusPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private async _runGateway(action: string) {
    if (process.platform === 'win32') {
      // Windows: Use terminal-based approach with openclaw gateway and Ctrl+C
      const terminal = this._ensureGatewayTerminal();
      terminal.show();
      if (action === 'restart') {
        const startCmd = 'openclaw gateway';
        terminal.sendText('\u0003', false);
        await new Promise(r => setTimeout(r, 1500));
        terminal.sendText(startCmd, true);
        vscode.window.showInformationMessage(`Sent: Ctrl+C then ${startCmd}`);
      } else {
        if (action === 'start') {
          const cmd = 'openclaw gateway';
          terminal.sendText(cmd, true);
          vscode.window.showInformationMessage(`Sent: ${cmd}`);
        } else {
          terminal.sendText('\u0003', false);
          vscode.window.showInformationMessage('Sent: Ctrl+C');
        }
      }
    } else {
      // Linux/Mac: Use CLI commands (openclaw gateway start/stop/restart)
      const cmd = `openclaw gateway ${action}`;
      const terminal = this._ensureGatewayTerminal();
      terminal.show();
      terminal.sendText(cmd, true);
      vscode.window.showInformationMessage(`Sent: ${cmd}`);
    }
    await this._update();
    await this._pollStatus(20000, 2000);
  }

  private async _update() {
    if (this._refreshing) {
      this._refreshQueued = true;
      return;
    }
    this._refreshing = true;
    try {
      const status = await this._getStatus();
      this._panel.webview.html = this._getHtml(status);
    } finally {
      this._refreshing = false;
      if (this._refreshQueued) {
        this._refreshQueued = false;
        void this._update();
      }
    }
  }

  private async _getStatus(): Promise<GatewayStatus> {
    const now = Date.now();
    if (this._lastStatus && now - this._lastStatusAt < 3000) {
      return this._lastStatus;
    }
    const status = await this._getStatusFresh();
    this._lastStatus = status;
    this._lastStatusAt = now;
    return status;
  }

  private async _getStatusFresh(): Promise<GatewayStatus> {
    const updatedAt = new Date().toLocaleTimeString();
    const { command, result, cliPath } = await this._runOpenClaw(['gateway', 'status'], 4000);
    const out = (result.stdout || result.stderr).trim();
    if (out.length > 0) {
      const parsed = this._parseStatus(out);
      const trimmedErr = result.stderr.trim();
      const genericFail = result.error && result.error.toLowerCase().startsWith('command failed');
      const error = trimmedErr || (!genericFail ? result.error : undefined);
      return {
        installed: parsed.installed || !result.notFound,
        running: parsed.running,
        pid: parsed.pid,
        port: parsed.port,
        uptime: parsed.uptime,
        service: parsed.service,
        dashboard: parsed.dashboard,
        probe: parsed.probe,
        logFile: parsed.logFile,
        configPath: parsed.configPath,
        issues: parsed.issues,
        exitCode: result.code,
        cliPath,
        command,
        stderr: trimmedErr || undefined,
        pathEnv: result.pathEnv,
        raw: out,
        error,
        updatedAt,
      };
    }

    if (result.notFound) {
      return {
        installed: false,
        running: false,
        exitCode: result.code,
        cliPath,
        command,
        stderr: result.stderr.trim() || undefined,
        pathEnv: result.pathEnv,
        raw: 'OpenClaw CLI not detected.',
        error: result.error,
        updatedAt,
      };
    }

    if (result.timedOut) {
      return {
        installed: !result.notFound,
        running: false,
        exitCode: result.code,
        cliPath,
        command,
        stderr: result.stderr.trim() || undefined,
        pathEnv: result.pathEnv,
        raw: 'Status command timed out.',
        error: result.error,
        updatedAt,
      };
    }

    return {
      installed: !result.notFound,
      running: false,
      exitCode: result.code,
      cliPath,
      command,
      stderr: result.stderr.trim() || undefined,
      pathEnv: result.pathEnv,
      raw: 'Failed to read gateway status.',
      error: result.error,
      updatedAt,
    };
  }

  private async _pollStatus(maxMs: number, intervalMs: number) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!this._isVisible) return;
      const status = await this._getStatusFresh();
      this._panel.webview.html = this._getHtml(status);
      if (status.running) return;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  private _ensureGatewayTerminal() {
    if (this._gatewayTerminal) return this._gatewayTerminal;
    const existing = vscode.window.terminals.find(t => t.name === 'OpenClaw Gateway');
    if (existing) {
      this._gatewayTerminal = existing;
      return existing;
    }
    this._gatewayTerminal = vscode.window.createTerminal('OpenClaw Gateway');
    return this._gatewayTerminal;
  }

  private _runCommand(cmd: string, timeoutMs: number): Promise<RunResult> {
    const env = this._buildExecEnv();
    return new Promise(resolve => {
      cp.exec(
        cmd,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env,
        },
        (error, stdout, stderr) => {
          const result: RunResult = {
            stdout: stdout?.toString() || '',
            stderr: stderr?.toString() || '',
            pathEnv: env.PATH,
            command: cmd,
          };
          if (error) {
            result.error = error.message || 'Command failed';
            const errCode = (error as any).code;
            result.code = errCode ? String(errCode) : undefined;
            result.timedOut = errCode === 'ETIMEDOUT';
            const text = `${result.stderr}\n${result.error}`.toLowerCase();
            result.notFound =
              errCode === 'ENOENT' ||
              text.includes('not recognized as an internal or external command') ||
              text.includes('command not found');
          }
          resolve(result);
        }
      );
    });
  }

  private _execFile(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
    const env = this._buildExecEnv();
    return new Promise(resolve => {
      cp.execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env,
        },
        (error, stdout, stderr) => {
          const result: RunResult = {
            stdout: stdout?.toString() || '',
            stderr: stderr?.toString() || '',
            pathEnv: env.PATH,
            command: [command, ...args].join(' '),
          };
          if (error) {
            result.error = error.message || 'Command failed';
            const errCode = (error as any).code;
            result.code = errCode ? String(errCode) : undefined;
            result.timedOut = errCode === 'ETIMEDOUT';
            const text = `${result.stderr}\n${result.error}`.toLowerCase();
            result.notFound =
              errCode === 'ENOENT' ||
              text.includes('not recognized as an internal or external command') ||
              text.includes('command not found');
          }
          resolve(result);
        }
      );
    });
  }

  private async _runOpenClaw(
    args: string[],
    timeoutMs: number = 30000
  ): Promise<{ result: RunResult; command: string; cliPath?: string }> {
    if (process.platform !== 'win32') {
      const cliPath = await this._findOpenClawPath();
      if (!cliPath) {
        return {
          result: {
            stdout: '',
            stderr: '',
            error: 'openclaw not found',
            notFound: true,
          },
          command: `openclaw ${args.join(' ')}`,
        };
      }
      const result = await this._execFile(cliPath, args, timeoutMs);
      return { result, command: `${cliPath} ${args.join(' ')}`, cliPath };
    }

    const mjs = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'npm',
      'node_modules',
      'openclaw',
      'openclaw.mjs'
    );

    // Find node.exe
    let nodeExe: string | undefined;
    const candidates = [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
    ].filter(Boolean) as string[];

    nodeExe = candidates.find(p => fs.existsSync(p));

    if (!nodeExe) {
      try {
        const result = cp.execSync('where node.exe', { timeout: 3000, encoding: 'utf8', windowsHide: true });
        const found = result.trim().split(/\r?\n/)[0]?.trim();
        if (found && fs.existsSync(found)) nodeExe = found;
      } catch {}
    }

    if (!nodeExe || !fs.existsSync(mjs)) {
      const cliPath = await this._findOpenClawPath();
      if (cliPath) {
        const result = await this._execFile(cliPath, args, timeoutMs);
        return { result, command: `${cliPath} ${args.join(' ')}`, cliPath };
      }
      return {
        result: {
          stdout: '',
          stderr: '',
          error: 'node.exe or openclaw.mjs not found',
          exitCode: -1,
          notFound: true,
        },
        command: 'openclaw ' + args.join(' '),
      };
    }

    const display = `node "${mjs}" ${args.join(' ')}`;
    const cmdLine = `node "${mjs}" ${args.join(' ')}`;

    const result = await new Promise<RunResult>((resolve) => {
      const child = cp.spawn(cmdLine, [], {
        timeout: timeoutMs,
        windowsHide: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', data => (stdout += data));
      child.stderr?.on('data', data => (stderr += data));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGTERM' || code === null) {
          resolve({ error: 'Timed out after 30s', stdout, stderr, exitCode: null });
        } else if (code !== 0) {
          resolve({ error: stderr.trim() || `Exit ${code}`, stdout, stderr, exitCode: code ?? undefined });
        } else {
          resolve({ stdout, stderr, exitCode: 0 });
        }
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolve({ error: err.message, stdout, stderr, exitCode: undefined });
      });
    });

    return { result, command: display, cliPath: mjs };
  }

  /** Find the full path to node.exe on Windows */
  private _findNodeExe(): string | undefined {
    if (process.platform !== 'win32') return 'node';
    
    // Check common install paths
    const candidates = [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
    ].filter(Boolean) as string[];
    
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    
    // Try where command
    try {
      const result = cp.execSync('where node.exe', { timeout: 3000, encoding: 'utf8', windowsHide: true });
      const found = result.trim().split(/\r?\n/)[0]?.trim();
      if (found && fs.existsSync(found)) return found;
    } catch {}
    
    return undefined;
  }

  private _buildExecEnv() {
    const env = { ...process.env };
    const basePath = env.PATH || (env as any).Path || '';
    const extra: string[] = [];
    if (process.platform === 'win32') {
      if (env.APPDATA) extra.push(path.join(env.APPDATA, 'npm'));
      if (env.ProgramFiles) extra.push(path.join(env.ProgramFiles, 'nodejs'));
      // Common Node.js install locations on Windows (nvm-windows, volta, fnm, scoop, etc.)
      const home = os.homedir();
      const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      extra.push(path.join(localAppData, 'Volta', 'bin'));
      extra.push(path.join(localAppData, 'fnm', 'node-versions'));
      extra.push(path.join(env.APPDATA || '', 'nvm'));
      extra.push(path.join(home, 'scoop', 'shims'));
      // Try to find node.exe from the extension host's own process
      const nodeDir = this._findNodeDir();
      if (nodeDir) extra.push(nodeDir);
      const systemRoot = env.SystemRoot || (env as any).WINDIR;
      if (systemRoot) extra.push(path.join(systemRoot, 'System32'));
    } else {
      extra.push('/usr/local/bin', '/opt/homebrew/bin');
      extra.push(path.join(os.homedir(), '.local', 'bin'));
      extra.push(path.join(os.homedir(), '.npm-global', 'bin'));
    }
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = [...extra, basePath].filter(Boolean).join(sep);
    (env as any).Path = env.PATH;
    return env;
  }

  /** Find the directory containing node.exe by checking common locations */
  private _findNodeDir(): string | undefined {
    if (process.platform !== 'win32') return undefined;
    // 1. Check if node.exe is alongside npm in APPDATA
    const appData = process.env.APPDATA;
    if (appData) {
      const npmDir = path.join(appData, 'npm');
      // npm .cmd shims use %~dp0\node.exe or fall back to 'node' on PATH
      // Check the nodejs install dir referenced by the shim
    }
    // 2. Check common install paths
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'nodejs'),
      path.join(os.homedir(), '.nvm', 'versions'),
    ].filter(Boolean) as string[];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'node.exe'))) return dir;
    }
    // 3. Try to extract node location from NVM_HOME or NVM_SYMLINK
    const nvmSymlink = process.env.NVM_SYMLINK;
    if (nvmSymlink && fs.existsSync(path.join(nvmSymlink, 'node.exe'))) return nvmSymlink;
    const nvmHome = process.env.NVM_HOME;
    if (nvmHome && fs.existsSync(nvmHome)) {
      // nvm-windows creates a symlink or uses a current version dir
      try {
        const entries = fs.readdirSync(nvmHome).filter(e => /^v?\d/.test(e));
        for (const entry of entries) {
          const p = path.join(nvmHome, entry);
          if (fs.existsSync(path.join(p, 'node.exe'))) return p;
        }
      } catch {}
    }
    return undefined;
  }

  private async _findOpenClawPath(): Promise<string | undefined> {
    for (const candidate of this._getWorkspaceCliCandidates()) {
      if (fs.existsSync(candidate)) return candidate;
    }

    const envPath = process.env.OPENCLAW_CLI;
    if (envPath && fs.existsSync(envPath)) return envPath;

    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        const p = path.join(appData, 'npm', 'openclaw.cmd');
        if (fs.existsSync(p)) return p;
      }
    }

    const cfgPath = vscode.workspace.getConfiguration('openclaw').get<string>('cliPath');
    if (cfgPath && fs.existsSync(cfgPath)) return cfgPath;

    let cmd = process.platform === 'win32' ? 'where openclaw' : 'which openclaw';
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const whereExe = path.join(systemRoot, 'System32', 'where.exe');
      cmd = `"${whereExe}" openclaw`;
    }
    const result = await this._runCommand(cmd, 2000);
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

    if (process.platform === 'win32') {
      const psPath = await this._findOpenClawViaPowerShell();
      if (psPath && fs.existsSync(psPath)) return psPath;
    }

    const npmCandidates = await this._getNpmGlobalCliCandidates();
    for (const candidate of npmCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    const candidates = this._getCandidateCliPaths();
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private _getWorkspaceCliCandidates(): string[] {
    const exts = process.platform === 'win32'
      ? ['openclaw.cmd', 'openclaw.exe', 'openclaw.ps1', 'openclaw.bat', 'openclaw']
      : ['openclaw'];
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const candidates: string[] = [];
    for (const root of folders) {
      for (const name of exts) {
        candidates.push(path.join(root, 'node_modules', '.bin', name));
      }
    }
    return candidates;
  }

  private async _findOpenClawViaPowerShell(): Promise<string | undefined> {
    const ps = 'powershell.exe';
    const cmd = [
      '-NoProfile',
      '-Command',
      '($c = Get-Command openclaw -ErrorAction SilentlyContinue | Select-Object -First 1); ' +
        'if ($c) { $c.Path; if (-not $c.Path) { $c.Source }; if (-not $c.Path -and -not $c.Source) { $c.Definition } }',
    ];
    const result = await this._execFile(ps, cmd, 2000);
    const out = (result.stdout || '').trim();
    if (!out) return undefined;
    return out.split(/\r?\n/)[0].trim();
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
        path.join(appData, 'npm', 'openclaw.ps1'),
        path.join(appData, 'npm', 'openclaw.bat'),
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
      const withExts = [
        `${base}.cmd`,
        `${base}.exe`,
        `${base}.ps1`,
        `${base}.bat`,
        base,
      ];
      return withExts;
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

  private _parseStatus(out: string) {
    const lower = out.toLowerCase();
    let running = /rpc probe:\s*ok/.test(lower);
    if (/rpc probe:\s*failed/.test(lower)) running = false;
    if (!/rpc probe:\s*(ok|failed)/.test(lower)) {
      running = /runtime:\s*running|gateway:\s*running/.test(lower) || /running|active|started/.test(lower);
      if (/not running|stopped|inactive|down|runtime:\s*stopped/.test(lower)) running = false;
    }

    const pid = out.match(/pid[:\s]+(\d+)/i)?.[1];
    const port = out.match(/port[:=\s]+(\d+)/i)?.[1];
    const uptime = out.match(/uptime[:\s]+([^\n]+)/i)?.[1];
    const service = out.match(/service:\s*([^\n]+)/i)?.[1]?.trim();
    const dashboard = out.match(/dashboard:\s*(https?:\/\/[^\s]+)/i)?.[1];
    const probe = out.match(/probe target:\s*([^\n]+)/i)?.[1]?.trim();
    const logFile = out.match(/file logs:\s*([^\n]+)/i)?.[1]?.trim();
    const configPath = out.match(/config \(cli\):\s*([^\n]+)/i)?.[1]?.trim();
    const installed = /openclaw\s+\d{4}\./i.test(out) || /openclaw/gi.test(out);
    const issues = this._extractIssues(out);

    return { running, pid, port, uptime, service, dashboard, probe, logFile, configPath, installed, issues };
  }

  private _extractIssues(out: string): string[] {
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const issues: string[] = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.startsWith('fix:') || lower.startsWith('troubles:') || lower.startsWith('troubleshooting:')) {
        issues.push(line);
        continue;
      }
      if (lower.includes('missing') && lower.includes('config')) {
        issues.push(line);
        continue;
      }
      if (lower.startsWith('rpc probe:') || lower.startsWith('service is loaded but not running')) {
        issues.push(line);
        continue;
      }
      if (lower.startsWith('runtime:') && lower.includes('stopped')) {
        issues.push(line);
        continue;
      }
      if (lower.includes('requires explicit credentials') || lower.includes('pass --token') || lower.includes('pass --password')) {
        issues.push(line);
        continue;
      }
    }
    return issues;
  }

  private _escapeHtml(input: string) {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      background: radial-gradient(900px 600px at -10% -10%, rgba(220,40,40,0.2), transparent),
                  radial-gradient(800px 400px at 120% 0%, rgba(220,40,40,0.12), transparent),
                  #121212;
      color: #ededed;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 20px;
    }
    h2 { color: #ff4b4b; letter-spacing: 0.2px; }
    .spinner {
      width: 38px;
      height: 38px;
      border: 3px solid rgba(220, 40, 40, 0.15);
      border-top-color: #dc2828;
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text {
      font-size: 13px;
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
  <h2>OpenClaw Gateway</h2>
  <div class="spinner"></div>
  <span class="loading-text">Fetching status<span class="loading-dots"></span></span>
</body>
</html>`;
  }

  private _getHtml(status: GatewayStatus): string {
    const { running, installed, dashboard, updatedAt } = status;
    const safeDashboard = this._escapeHtml(dashboard || '—');
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      background: radial-gradient(900px 600px at -10% -10%, rgba(220,40,40,0.2), transparent),
                  radial-gradient(800px 400px at 120% 0%, rgba(220,40,40,0.12), transparent),
                  #121212;
      color: #ededed;
      padding: 26px;
    }
    h2 { color: #ff4b4b; margin-bottom: 6px; letter-spacing: 0.2px; }
    .subtitle { color: #b8b8b8; font-size: 12px; margin-bottom: 18px; }
    .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .indicator { width: 12px; height: 12px; border-radius: 50%; }
    .on { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,0.4); }
    .off { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,0.4); }
    .pill {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: #1f1f1f;
      border: 1px solid #2f2f2f;
      color: #d0d0d0;
    }
    .card {
      background: rgba(18,18,18,0.85);
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 16px;
    }
    .kv {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      font-size: 13px;
      color: #d2d2d2;
      min-width: 0;
    }
    .kv span:first-child {
      color: #9a9a9a;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .kv span:last-child,
    .kv a {
      text-align: right;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button {
      padding: 8px 18px;
      border-radius: 6px;
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-start { background: #4ade80; color: #1a1a1a; }
    .btn-stop { background: #ef4444; color: #fff; }
    .btn-restart { background: #f59e0b; color: #141414; }
    .btn-refresh { background: #222; color: #bdbdbd; border: 1px solid #3a3a3a; }
    .btn-install { background: #dc2828; color: #fff; }
    .link {
      color: #dbeafe;
      text-decoration: none;
    }
    .link:hover { text-decoration: underline; }
    .muted { color: #9a9a9a; font-size: 12px; }
  </style>
</head>
<body>
  <h2>OpenClaw Gateway</h2>
  <div class="subtitle">Last updated: ${updatedAt}</div>
  <div class="status-row">
    <span class="indicator ${running ? 'on' : 'off'}"></span>
    <span>${running ? 'Running' : installed ? 'Stopped' : 'Not Installed'}</span>
    <span class="pill">${running ? 'Healthy' : installed ? 'Offline' : 'Missing'}</span>
  </div>
  <div class="card">
    <div class="kv"><span>Status</span><span>${running ? 'Running' : installed ? 'Stopped' : 'Missing'}</span></div>
  </div>
  <div class="card">
    <div class="kv">
      <span>Dashboard</span>
      ${dashboard ? `<a class="link" href="#" data-cmd="open-dashboard">${safeDashboard}</a>` : `<span>${safeDashboard}</span>`}
    </div>
  </div>
  <div class="actions">
    ${installed
      ? (running
          ? '<button class="btn-stop" data-cmd="gateway-stop">Stop Gateway</button>'
          : '<button class="btn-start" data-cmd="gateway-start">Start Gateway</button>')
      : '<button class="btn-install" data-cmd="install">Install OpenClaw</button>'}
    ${installed ? '<button class="btn-restart" data-cmd="gateway-restart">Restart Gateway</button>' : ''}
    <button class="btn-refresh" data-cmd="refresh">Refresh</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const dashboardUrl = ${JSON.stringify(dashboard || '')};
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-cmd]');
      if (link) {
        const cmd = link.getAttribute('data-cmd');
        if (cmd === 'open-dashboard') return vscode.postMessage({ command: cmd, url: dashboardUrl });
      }
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');
      vscode.postMessage({ command: cmd });
    });
    setInterval(() => vscode.postMessage({ command: 'refresh' }), 20000);
  </script>
</body>
</html>`;
  }
}
