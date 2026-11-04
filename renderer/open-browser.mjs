import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function openHtml(file, { platform = process.platform, run = execFileSync, home = homedir() } = {}) {
  const url = pathToFileURL(file).href;
  if (platform === 'darwin') {
    let browser = 'com.apple.Safari';
    try {
      const plist = home + '/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';
      const prefs = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
      const handlers = prefs.LSHandlers || [];
      browser = handlers.find(h => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll
        || handlers.find(h => h.LSHandlerURLScheme === 'http')?.LSHandlerRoleAll || browser;
    } catch { /* macOS defaults to Safari when no explicit handler exists. */ }
    run('/usr/bin/open', ['-b', browser, url]);
  } else if (platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const command = String.raw`$ErrorActionPreference='Stop'; $id=(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice').ProgId; $cmd=(Get-Item ('Registry::HKEY_CLASSES_ROOT\'+$id+'\shell\open\command')).GetValue(''); if ($cmd -match '^"([^"]+)"') { $exe=$Matches[1] } elseif ($cmd -match '^(\S+)') { $exe=$Matches[1] } else { throw 'Cannot locate default browser' }; Start-Process -FilePath $exe -ArgumentList ('"'+${quote(url)}+'"')`;
    run('powershell', ['-NoProfile', '-Command', command]);
  } else {
    const browser = run('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim();
    if (!browser) throw new Error('No default browser is configured');
    run('gtk-launch', [browser, url]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { openHtml(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
