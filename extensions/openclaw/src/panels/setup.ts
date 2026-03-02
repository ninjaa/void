import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { resolveConfigPath } from "./config-path";

type ChannelAccount = {
  id: string;
  title: string;
  status: "connected" | "needs-relink";
};

type ChannelSummary = {
  channel: string;
  description: string;
  accounts: ChannelAccount[];
};

type ControlCenterData = {
  agents: { id: string }[];
  channels: ChannelSummary[];
  automation: { cronJobs: { status: "enabled" | "paused" }[] };
  maintenance: { doctor: { status: "healthy" | "warning" | "error" } };
};

function sanitizeJson5(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*(\}|\])/g, "$1");
}

function readOpenClawConfig(configPath: string): any | null {
  try {
    const contents = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(sanitizeJson5(contents));
  } catch (error) {
    console.warn("[OpenClaw] Unable to read openclaw.json:", error);
    return null;
  }
}

function readOpenClawConfigRaw(configPath: string): string {
  try {
    return fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    console.warn("[OpenClaw] Unable to read raw openclaw.json:", error);
    return getDefaultConfig();
  }
}

function getDefaultConfig(): string {
  return `{
  // OpenClaw configuration
  "agents": {
    "list": []
  },
  "channels": {},
  "automation": {
    "cronJobs": []
  },
  "gateway": {
    "port": 3000,
    "host": "localhost"
  }
}`;
}

function buildControlCenterData(configPath: string): ControlCenterData {
  const rawConfig = readOpenClawConfig(configPath);
  
  if (!rawConfig) {
    // Return empty state if no config exists or is invalid
    return {
      agents: [],
      channels: [],
      automation: { cronJobs: [] },
      maintenance: { doctor: { status: "healthy" } },
    };
  }

  const agents = rawConfig?.agents?.list?.map((a: any) => ({ id: a.id || "unknown" })) ?? [];
  const channelsConfig = rawConfig?.channels ?? {};

  const channels: ChannelSummary[] = Object.entries(channelsConfig).map(
    ([channelKey, channelData]: [string, any]) => {
      const enabled = channelData?.enabled ?? false;
      return {
        channel: channelKey,
        description: `${channelKey} surface configuration`,
        accounts: [
          { 
            id: `${channelKey}-primary`, 
            title: `${channelKey} · Primary`, 
            status: enabled ? "connected" : "needs-relink" 
          },
        ],
      };
    }
  );

  const cronJobs = rawConfig?.automation?.cronJobs ?? [];

  return {
    agents,
    channels,
    automation: {
      cronJobs: cronJobs.map((j: any) => ({ 
        status: j?.status === "paused" ? "paused" : "enabled" 
      })),
    },
    maintenance: {
      doctor: { status: "healthy" },
    },
  };
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class ConfigPanel {
  public static currentPanel: ConfigPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _fileWatcher: vscode.FileSystemWatcher | undefined;
  private _lastModified: number = 0;

  public static createOrShow(extensionUri: vscode.Uri) {
    if (ConfigPanel.currentPanel) {
      ConfigPanel.currentPanel.dispose();
    }
    const panel = vscode.window.createWebviewPanel(
      "openclawConfigV2",
      "OpenClaw Configuration",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    ConfigPanel.currentPanel = new ConfigPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    // Set up file watcher for auto-refresh
    this._setupFileWatcher();
    
    this._panel.webview.onDidReceiveMessage((message) => {
      // Webview signals it has loaded the external script and is ready for data
      if (message?.command === "ready") {
        void this._panel.webview.postMessage({
          command: "init",
          data: buildControlCenterData(resolveConfigPath()),
          config: readOpenClawConfigRaw(resolveConfigPath()),
        });
        return;
      }
      if (message?.command === "refresh") {
        void this._update();
        return;
      }
      if (message?.command === "openclaw.channelAdd") {
        this._openChannelInstallerTerminal();
        return;
      }
      if (message?.command === "openclaw.saveConfig") {
        const configPath = resolveConfigPath();
        const text = message?.text || "";
        
        try {
          // Validate JSON5 before saving
          JSON.parse(sanitizeJson5(text));
          
          // Ensure directory exists
          const configDir = path.dirname(configPath);
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }
          
          // Write the config
          fs.writeFileSync(configPath, text, "utf-8");
          console.log("[OpenClaw] Config saved to:", configPath);
          
          this._panel.webview.postMessage({ command: "openclaw.saveResult", ok: true });
          
          // Refresh the view with new data
          void this._update();
        } catch (err: any) {
          console.error("[OpenClaw] Failed to save config:", err);
          this._panel.webview.postMessage({ 
            command: "openclaw.saveResult", 
            ok: false, 
            error: err.message || "Failed to save configuration" 
          });
        }
        return;
      }
      if (message?.command === "openclaw.runCommand") {
        const input = String(message?.text ?? "").trim();
        if (!input) return;
        const terminal = vscode.window.createTerminal("openclaw command console");
        terminal.show();
        const command = input.startsWith("openclaw") ? input : "openclaw " + input;
        terminal.sendText(command, true);
        return;
      }
      if (message?.command === "openclaw.channelPair") {
        const channelName = String(message?.channel ?? "").trim();
        const terminal = vscode.window.createTerminal("openclaw pair " + (channelName || 'channel'));
        terminal.show();
        terminal.sendText("openclaw channels pair " + (channelName || ''), true);
        return;
      }
      if (message?.command === "openclaw.channelConfigure") {
        const channelName = String(message?.channel ?? "").trim();
        vscode.window.showInformationMessage(
          "Configure " + (channelName || "channel") + " — edit the config JSON in the Advanced Configuration tab."
        );
        return;
      }
      if (message?.command === "openclaw.viewStatus") {
        vscode.commands.executeCommand("openclaw.status");
        return;
      }
    });
    void this._update();
  }

  public dispose() {
    ConfigPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async _update() {
    const configPath = resolveConfigPath();
    const data = buildControlCenterData(configPath);
    const rawConfig = readOpenClawConfigRaw(configPath);
    this._panel.webview.html = this._getHtml(data, rawConfig);
  }

  private _setupFileWatcher() {
    const configPath = resolveConfigPath();
    
    // Watch the config file for changes
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(configPath)), path.basename(configPath))
    );
    
    // Debounced refresh on change
    const debouncedRefresh = this._debounce(() => {
      const stats = fs.statSync(configPath);
      if (stats.mtimeMs > this._lastModified) {
        this._lastModified = stats.mtimeMs;
        console.log("[OpenClaw] Config file changed, refreshing...");
        void this._pushRefresh();
      }
    }, 300);
    
    this._fileWatcher.onDidChange(debouncedRefresh, null, this._disposables);
    this._fileWatcher.onDidCreate(debouncedRefresh, null, this._disposables);
    
    // Set initial modified time
    try {
      const stats = fs.statSync(configPath);
      this._lastModified = stats.mtimeMs;
    } catch {
      this._lastModified = 0;
    }
  }

  private _debounce(fn: () => void, ms: number) {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  private async _pushRefresh() {
    const configPath = resolveConfigPath();
    const data = buildControlCenterData(configPath);
    const rawConfig = readOpenClawConfigRaw(configPath);
    
    await this._panel.webview.postMessage({
      command: "refresh",
      data,
      config: rawConfig,
    });
  }

  private _openChannelInstallerTerminal() {
    const terminal = vscode.window.createTerminal("openclaw channel installer");
    terminal.show();
    terminal.sendText("openclaw channels add", true);
  }

  private _getHtml(data: ControlCenterData, rawConfig: string) {
    const webview = this._panel.webview;

    // External script loaded via webview URI — this is the ONLY reliable way
    // to run JS in modern VS Code / VSCodium because the frame-level CSP requires
    // resources to come from webview.cspSource (extension media folder).
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "setup-panel.js")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource} https:`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} https:`,
    ].join("; ");

    const serialized = JSON.stringify(data).replace(/</g, "\\u003c");
    const serializedConfig = JSON.stringify(rawConfig || "").replace(/</g, "\\u003c");

    const connectedChannels = data.channels.filter((channel) =>
      channel.accounts.some((account) => account.status === "connected")
    ).length;
    const channelCount = data.channels.length;

    const channelCards = data.channels
      .map((channel, index) => {
        const connected = channel.accounts.some((account) => account.status === "connected");
        const needsReview = channel.accounts.some((account) => account.status === "needs-relink");
        const status = connected ? "Connected" : needsReview ? "Needs review" : "Not connected";
        const chipClass = connected ? "chip-good" : needsReview ? "chip-warn" : "chip-bad";
        const accountChips = channel.accounts
          .map((account) => '<span class="pill">' + account.title + '</span>')
          .join("");

        return `
          <div class="channel-card${index === 0 ? " active" : ""}" data-index="${index}">
            <div class="card-row">
              <div>
                <div class="card-title">${channel.channel}</div>
                <div class="card-sub">${channel.description}</div>
              </div>
              <div class="status-chip">
                <span class="dot ${chipClass}"></span>
                <span>${status}</span>
              </div>
            </div>
            <div class="pill-row">${accountChips}</div>
            <div class="card-actions">
              <button class="btn-secondary btn-sm" data-action="pair" data-index="${index}">Pair</button>
              <button class="btn-secondary btn-sm" data-action="configure" data-index="${index}">Configure</button>
            </div>
          </div>
        `;
      })
      .join("");

    const baseStyles = `
      :root {
        color-scheme: dark;
        --accent: #ef4444;
        --accent-hover: #dc2626;
        --bg: #0b0a0a;
        --bg-card: #151111;
        --bg-elevated: #1d1414;
        --border: #3a1f1f;
        --text: #f8f2f2;
        --text-muted: #b9a8a8;
        --chip-good: #22c55e;
        --chip-warn: #f59e0b;
        --chip-bad: #ef4444;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--vscode-font-family, "Inter", system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
      }
      * { box-sizing: border-box; }
      #app { min-height: 100vh; }
      .container { max-width: 1440px; margin: 0 auto; padding: 24px; }
      
      /* Header */
      .header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
      .header-title { display: flex; align-items: center; gap: 12px; font-size: 20px; font-weight: 600; }
      .header-dot { height: 10px; width: 10px; border-radius: 999px; background: var(--accent); display: inline-block; }
      .header-meta { font-size: 12px; color: var(--text-muted); }
      
      /* Tabs */
      .tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
      .tab { border: none; cursor: pointer; border-radius: 8px; padding: 8px 16px; font-size: 13px; background: transparent; color: var(--text-muted); transition: all 0.2s; }
      .tab:hover { background: var(--bg-elevated); color: var(--text); }
      .tab.active { background: var(--accent); color: #081018; font-weight: 600; }
      
      /* Tab Content */
      .tab-panel { display: none; }
      .tab-panel.active { display: block; }
      
      /* Panel Layout */
      .panel-grid { display: grid; gap: 20px; grid-template-columns: 1fr 320px; }
      .panel { border-radius: 16px; background: var(--bg-card); padding: 20px; }
      .panel h2 { margin: 0 0 16px 0; font-size: 18px; font-weight: 600; }
      .panel-subtitle { margin: -12px 0 20px 0; font-size: 13px; color: var(--text-muted); }
      
      /* Buttons */
      .btn-primary { border: none; cursor: pointer; background: var(--accent); color: #081018; padding: 10px 16px; border-radius: 8px; font-size: 12px; font-weight: 600; transition: background 0.2s; }
      .btn-primary:hover { background: var(--accent-hover); }
      .btn-secondary { border: 1px solid var(--border); background: transparent; color: var(--text-muted); padding: 6px 12px; border-radius: 8px; font-size: 11px; cursor: pointer; transition: all 0.2s; }
      .btn-secondary:hover { border-color: var(--accent); color: var(--text); }
      .btn-sm { padding: 4px 10px; font-size: 11px; }
      .btn-block { width: 100%; margin-top: 12px; }
      
      /* Channel Cards */
      .channel-list { display: grid; gap: 12px; }
      .channel-card { border-radius: 12px; border: 1px solid var(--border); background: var(--bg-elevated); padding: 16px; transition: border-color 0.2s; }
      .channel-card:hover { border-color: var(--accent); }
      .channel-card.active { border-color: var(--accent); background: var(--bg-card); }
      .card-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
      .card-title { font-size: 14px; font-weight: 600; text-transform: capitalize; }
      .card-sub { margin-top: 4px; font-size: 12px; color: var(--text-muted); }
      .card-actions { margin-top: 12px; display: flex; gap: 8px; }
      
      /* Status Chips */
      .status-chip { display: flex; align-items: center; gap: 6px; border-radius: 999px; background: var(--bg); padding: 4px 10px; font-size: 11px; color: var(--text); }
      .dot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; }
      .chip-good { background: var(--chip-good); }
      .chip-warn { background: var(--chip-warn); }
      .chip-bad { background: var(--chip-bad); }
      
      /* Pills */
      .pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .pill { padding: 4px 10px; border-radius: 999px; background: var(--bg-card); font-size: 11px; color: var(--text-muted); }
      .pill.clickable { cursor: pointer; transition: all 0.2s; }
      .pill.clickable:hover { background: var(--accent); color: #081018; }
      
      /* JSON Editor */
      .json-editor { width: 100%; min-height: 400px; resize: vertical; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text); padding: 16px; font-size: 13px; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; tab-size: 2; }
      .json-editor:focus { outline: none; border-color: var(--accent); }
      .editor-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .editor-status { display: flex; align-items: center; gap: 12px; font-size: 12px; margin-bottom: 10px; }
      .status-badge { padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 500; }
      .status-badge.ok { background: var(--chip-good); color: #0f172a; }
      .status-badge.err { background: var(--chip-bad); color: white; }
      .status-badge.warn { background: var(--chip-warn); color: #0f172a; }
      
      /* Command Console */
      .console-layout { display: grid; gap: 20px; grid-template-columns: 1fr 280px; }
      .command-input-wrap { display: flex; gap: 12px; margin-bottom: 16px; }
      .command-input { flex: 1; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text); padding: 12px 16px; font-size: 13px; font-family: ui-monospace, monospace; }
      .command-input:focus { outline: none; border-color: var(--accent); }
      .quick-commands h3 { margin: 0 0 12px 0; font-size: 13px; color: var(--text-muted); font-weight: 500; }
      .quick-grid { display: grid; gap: 8px; }
      .quick-btn { text-align: left; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text); font-size: 12px; cursor: pointer; transition: all 0.2s; }
      .quick-btn:hover { border-color: var(--accent); background: var(--bg-card); }
      .quick-btn strong { display: block; font-size: 12px; margin-bottom: 2px; }
      .quick-btn span { display: block; font-size: 11px; color: var(--text-muted); }
      
      /* Sidebar */
      .sidebar h3 { margin: 0 0 12px 0; font-size: 13px; color: var(--text-muted); font-weight: 500; }
      .info-card { padding: 12px; border-radius: 10px; background: var(--bg-elevated); margin-bottom: 12px; }
      .info-card h4 { margin: 0 0 6px 0; font-size: 12px; color: var(--text); }
      .info-card p { margin: 0; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
      .connection-status { display: flex; align-items: center; gap: 8px; padding: 12px; border-radius: 10px; background: var(--bg-elevated); margin-top: 16px; }
      
      .panel-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
      .empty-state { color: var(--text-muted); text-align: center; padding: 40px; }
      .status-text { font-size: 12px; }
      .hint-text { font-size: 11px; color: var(--text-muted); margin-right: 8px; }
      .recent-row { margin-bottom: 16px; }

      /* ── Responsive ──────────────────────────────────────────── */

      /* Collapse sidebars on medium-width panels */
      @media (max-width: 820px) {
        .panel-grid { grid-template-columns: 1fr; }
        .console-layout { grid-template-columns: 1fr; }
        .sidebar { order: -1; }
        /* Make quick-commands horizontal on medium */
        .quick-grid { grid-template-columns: repeat(2, 1fr); }
      }

      /* Compact spacing on narrow panels */
      @media (max-width: 640px) {
        .container { padding: 14px; }
        .tabs { gap: 4px; padding-bottom: 10px; flex-wrap: wrap; }
        .tab { padding: 6px 10px; font-size: 12px; }
        .panel { padding: 14px; border-radius: 12px; }
        .panel h2 { font-size: 15px; }
        .panel-grid { gap: 14px; }
        .console-layout { gap: 14px; }
        .header-title { font-size: 17px; }
        .json-editor { min-height: 260px; }
        .quick-grid { grid-template-columns: 1fr; }
        .command-input-wrap { flex-wrap: wrap; }
        .command-input { min-width: 0; width: 100%; }
        .card-row { flex-wrap: wrap; }
      }

      /* Very narrow panels (sidebar panel view) */
      @media (max-width: 400px) {
        .container { padding: 10px; }
        .tabs { gap: 4px; }
        .tab { padding: 5px 8px; font-size: 11px; border-radius: 6px; }
        .panel { padding: 10px; border-radius: 10px; }
        .panel h2 { font-size: 14px; margin-bottom: 12px; }
        .header { gap: 8px; margin-bottom: 14px; }
        .header-title { font-size: 15px; gap: 8px; }
        .channel-card { padding: 12px; }
        .card-actions { flex-wrap: wrap; }
        .btn-primary, .btn-secondary { font-size: 11px; }
        .editor-toolbar { flex-wrap: wrap; gap: 8px; }
        .editor-toolbar > div { flex: 1 1 100%; }
        .panel-header-row { flex-wrap: wrap; gap: 8px; }
        .panel-header-row > div { flex: 1 1 100%; }
        .panel-header-row .btn-primary { width: 100%; }
        .json-editor { min-height: 200px; font-size: 12px; }
        .status-chip { font-size: 10px; padding: 3px 8px; }
        .info-card { padding: 10px; }
      }
    `;
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${baseStyles}</style>
  </head>
  <body>
    <div id="app">
      <div class="container">
        <div class="header">
          <div class="header-title">
            <span class="header-dot"></span>
            <span>OpenClaw Configuration</span>
          </div>
          <div class="header-meta">${connectedChannels}/${channelCount} channels connected</div>
        </div>

        <div class="tabs">
          <button class="tab active" data-tab="channels">Channel Management</button>
          <button class="tab" data-tab="config">Advanced Configuration</button>
          <button class="tab" data-tab="console">Command Console</button>
        </div>

        <!-- TAB 1: Channel Management -->
        <div class="tab-panel active" id="tab-channels">
          <div class="panel-grid">
            <div class="panel">
              <div class="panel-header-row">
                <div>
                  <h2>Channels</h2>
                  <div class="panel-subtitle">Manage your communication channels</div>
                </div>
                <button class="btn-primary" id="add-channel">+ Add Channel</button>
              </div>
              <div class="channel-list" id="channel-list">
                ${channelCards || '<div class="empty-state">No channels configured. Add your first channel to get started.</div>'}
              </div>
            </div>
            <div class="panel sidebar">
              <h3>Quick Actions</h3>
              <div class="info-card">
                <h4>Add Channel</h4>
                <p>Connect WhatsApp, Telegram, or other messaging platforms.</p>
                <button class="btn-primary btn-block" id="sidebar-add">Add New</button>
              </div>
              <div class="connection-status">
                <span class="dot ${connectedChannels > 0 ? 'chip-good' : 'chip-warn'}"></span>
                <span class="status-text">${connectedChannels > 0 ? 'Channels active' : 'No active channels'}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: Advanced Configuration -->
        <div class="tab-panel" id="tab-config">
          <div class="panel-grid">
            <div class="panel">
              <div class="editor-toolbar">
                <div>
                  <h2>Configuration JSON</h2>
                  <div class="panel-subtitle">Edit ~/.openclaw/openclaw.json directly</div>
                </div>
                <button class="btn-primary" id="save-config">Save Changes</button>
              </div>
              <div class="editor-status">
                <span class="status-badge warn" id="config-status">Loading...</span>
                <span class="hint-text" id="config-hint">Supports JSON5 (comments + trailing commas)</span>
              </div>
              <textarea class="json-editor" id="config-editor" spellcheck="false"></textarea>
            </div>
            <div class="panel sidebar">
              <h3>Validation</h3>
              <div class="info-card">
                <h4>JSON5 Support</h4>
                <p>You can use comments (// and /* */) and trailing commas.</p>
              </div>
              <div class="info-card">
                <h4>Common Issues</h4>
                <p>• Missing quotes on keys<br>• Trailing commas in arrays<br>• Invalid escape sequences</p>
              </div>
              <div class="info-card">
                <h4>After Saving</h4>
                <p>Restart the gateway for changes to take effect.</p>
                <button class="btn-secondary btn-block" id="restart-hint">View Status Panel</button>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 3: Command Console -->
        <div class="tab-panel" id="tab-console">
          <div class="console-layout">
            <div class="panel">
              <h2>Command Console</h2>
              <div class="panel-subtitle">Run OpenClaw CLI commands</div>
              <div class="command-input-wrap">
                <input type="text" class="command-input" id="command-input" placeholder="Enter command (e.g., doctor, status, gateway start)" />
                <button class="btn-primary" id="run-command">Run</button>
              </div>
              <div class="pill-row recent-row" id="recent-commands">
                <span class="hint-text">Recent:</span>
              </div>
            </div>
            <div class="panel sidebar">
              <div class="quick-commands">
                <h3>Quick Commands</h3>
                <div class="quick-grid">
                  <button class="quick-btn" data-cmd="doctor">
                    <strong>doctor</strong>
                    <span>Run health diagnostics</span>
                  </button>
                  <button class="quick-btn" data-cmd="status">
                    <strong>status</strong>
                    <span>Check overall status</span>
                  </button>
                  <button class="quick-btn" data-cmd="gateway status">
                    <strong>gateway status</strong>
                    <span>Check gateway state</span>
                  </button>
                  <button class="quick-btn" data-cmd="channels status --probe">
                    <strong>channels status</strong>
                    <span>Test channel connectivity</span>
                  </button>
                  <button class="quick-btn" data-cmd="logs --follow">
                    <strong>logs --follow</strong>
                    <span>Watch live logs</span>
                  </button>
                  <button class="quick-btn" data-cmd="version">
                    <strong>version</strong>
                    <span>Show CLI version</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

  <script src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
