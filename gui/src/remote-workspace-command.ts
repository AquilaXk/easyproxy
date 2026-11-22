function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Technical shell samples; kept outside JSX/i18n because command syntax is not prose. */
export function remoteWorkspacePairingCommands(code: string, hubOrigin: string): {
  posix: string;
  powershell: string;
} {
  return {
    posix: `printf '%s\\n' ${posixQuote(code)} | epx remote-workspace pair ${posixQuote(hubOrigin)} --pairing-code-stdin --root "$PWD" && epx remote-workspace agent`,
    powershell: `$pairingCode = ${powershellQuote(code)}; $pairingCode | epx remote-workspace pair ${powershellQuote(hubOrigin)} --pairing-code-stdin --root (Get-Location).Path; if ($LASTEXITCODE -eq 0) { epx remote-workspace agent }`,
  };
}
