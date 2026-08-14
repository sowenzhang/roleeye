import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeliveryResult, Notification, Notifier } from './notifier.js';

const run = promisify(execFile);

/**
 * Windows toast notifications with no native dependency.
 *
 * Verified on this machine: WinRT types are unavailable in PowerShell 7, so the
 * script must run under Windows PowerShell 5.1, and both the notification
 * manager *and* the XML document type have to be loaded explicitly.
 *
 * The toast content is passed through an environment variable rather than the
 * script text. Company names and job titles are attacker-chosen, and a title
 * containing a quote would otherwise terminate a PowerShell string literal.
 * An environment variable is data to PowerShell, never code.
 */

const POWERSHELL = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** PowerShell's own registered AppUserModelID; toasts need one that exists. */
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const SCRIPT = [
  '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
  '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
  '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$doc.LoadXml($env:ROLEEYE_TOAST_XML)',
  '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
].join('\n');

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not valid in XML 1.0 and would fail the load.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

export function buildToastXml(notification: Notification, maxItems: number): string {
  const lines = notification.items
    .slice(0, maxItems)
    .map((item) => `${item.company} — ${item.title} (${item.decision} ${item.score})`);

  const body = lines.length > 0 ? lines.join('\n') : notification.detail;

  return [
    '<toast activationType="foreground">',
    '<visual><binding template="ToastGeneric">',
    `<text>${escapeXml(notification.summary)}</text>`,
    `<text>${escapeXml(body)}</text>`,
    `<text placement="attribution">${escapeXml(notification.reviewHint)}</text>`,
    '</binding></visual>',
    '</toast>',
  ].join('');
}

export interface DesktopOptions {
  maxItems: number;
  platform?: string;
  exec?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<unknown>;
}

export function createDesktopNotifier(options: DesktopOptions): Notifier {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? ((command, args, opts) => run(command, args, { ...opts, windowsHide: true }));

  return {
    channel: 'desktop',

    async send(notification): Promise<DeliveryResult> {
      if (platform !== 'win32') {
        // Saying so beats a silent no-op that looks like a delivered message.
        return { channel: 'desktop', delivered: false, reason: `desktop notifications need Windows, not ${platform}` };
      }

      const xml = buildToastXml(notification, options.maxItems);
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

      await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, ROLEEYE_TOAST_XML: xml },
        timeout: 15_000,
      });

      return { channel: 'desktop', delivered: true };
    },
  };
}
