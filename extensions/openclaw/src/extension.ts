import * as vscode from 'vscode';
import { HomePanel } from './panels/home';
import { ConfigPanel } from './panels/setup';
import { StatusPanel } from './panels/status';

/** Activity-bar container IDs to hide from every OCcode installation. */
const HIDDEN_ACTIVITY_BAR_IDS = [
  'workbench.view.scm',        // Source Control
  'workbench.view.debug',      // Run and Debug
  'workbench.view.extensions', // Extensions
] as const;

type PinnedContainer = {
  id: string;
  pinned: boolean;
  visible: boolean;
  order?: number;
};

/**
 * Hides the specified activity bar containers.
 * Reads the current `workbench.activityBar.pinnedViewContainers` value,
 * marks the target containers as hidden, then persists to GlobalTarget
 * so the change applies across all workspaces on this machine.
 */
async function hideActivityBarItems(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Only run once per installation to avoid fighting user customisations.
  const APPLIED_KEY = 'activityBarHiddenConfigured';
  if (context.globalState.get<boolean>(APPLIED_KEY, false)) {
    return;
  }

  try {
    const config = vscode.workspace.getConfiguration();
    const current =
      config.get<PinnedContainer[]>('workbench.activityBar.pinnedViewContainers') ?? [];

    // Clone array so we can mutate safely.
    const updated: PinnedContainer[] = current.map(c => ({ ...c }));

    for (const id of HIDDEN_ACTIVITY_BAR_IDS) {
      const entry = updated.find(c => c.id === id);
      if (entry) {
        entry.visible = false;
        entry.pinned = false;
      } else {
        updated.push({ id, pinned: false, visible: false });
      }
    }

    await config.update(
      'workbench.activityBar.pinnedViewContainers',
      updated,
      vscode.ConfigurationTarget.Global,
    );

    await context.globalState.update(APPLIED_KEY, true);
  } catch {
    // Non-fatal — wrapper's settings.json defaults already cover most cases.
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Apply hidden activity bar items on first activation on this machine.
  await hideActivityBarItems(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('openclaw.home', () => {
      HomePanel.createOrShow(context.extensionUri);
    }),
    vscode.commands.registerCommand('openclaw.configure', () => {
      ConfigPanel.createOrShow(context.extensionUri);
    }),
    vscode.commands.registerCommand('openclaw.install', () => {
      const platform = process.platform;
      const shell = (vscode.env.shell || '').toLowerCase();
      let installCmd = 'curl -fsSL https://openclaw.ai/install.sh | bash';

      if (platform === 'win32') {
        const isPowerShell = shell.includes('powershell') || shell.includes('pwsh');
        installCmd = isPowerShell
          ? 'iwr -useb https://openclaw.ai/install.ps1 | iex'
          : 'curl -fsSL https://openclaw.ai/install.cmd -o install.cmd && install.cmd && del install.cmd';
      }

      const terminal = vscode.window.createTerminal('OpenClaw Install');
      terminal.show();
      terminal.sendText(installCmd);
    }),
    vscode.commands.registerCommand('openclaw.status', () => {
      StatusPanel.createOrShow(context.extensionUri);
    }),
  );

  // Auto-show Home panel on startup (after activation settles)
  setTimeout(() => {
    HomePanel.createOrShow(context.extensionUri);
  }, 250);
}

export function deactivate() {}
