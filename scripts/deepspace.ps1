<#
.SYNOPSIS
  Runs the DeepSpace CLI against staging with this machine's agent account.

.DESCRIPTION
  The staging agent account phrase is stored encrypted with Windows DPAPI at
  %LOCALAPPDATA%\DispatchDeck\account.dpapi (readable only by this Windows user).
  The CLI reads agent credentials from a file named by
  DEEPSPACE_AGENT_CREDENTIAL_FILE, so this script decrypts the phrase into a
  single-use file in the same private folder, runs one CLI command, and deletes
  the file even if the command fails. The phrase never enters the repository,
  the command line, or the console.

.EXAMPLE
  npm run deepspace -- deploy --json
  npm run deepspace -- secrets list --json
  npm run deepspace -- logs --follow
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
$ErrorActionPreference = 'Stop'

$private = Join-Path $env:LOCALAPPDATA 'DispatchDeck'
$sealed = Join-Path $private 'account.dpapi'
if (-not (Test-Path $sealed)) { throw "No DPAPI-sealed account phrase at $sealed." }

$credentialFile = Join-Path $private ("cli-" + [guid]::NewGuid() + '.json')
try {
  $secure = Get-Content $sealed | ConvertTo-SecureString
  $phrase = [System.Net.NetworkCredential]::new('', $secure).Password.Trim() -replace '\s+', ' '
  @{ version = 1; authUrl = 'https://auth.deepspacesites.com'; name = 'dispatchdeck'; credential = $phrase } |
    ConvertTo-Json -Compress | Set-Content -Encoding ascii -NoNewline $credentialFile
  Remove-Variable phrase, secure

  $env:DEEPSPACE_ENV = 'staging'
  $env:DEEPSPACE_AGENT_CREDENTIAL_FILE = $credentialFile
  Push-Location (Split-Path $PSScriptRoot -Parent)
  try { & npx.cmd deepspace @CliArgs; $code = $LASTEXITCODE } finally { Pop-Location }
}
finally {
  Remove-Item -Force $credentialFile -ErrorAction SilentlyContinue
  Remove-Item Env:DEEPSPACE_AGENT_CREDENTIAL_FILE -ErrorAction SilentlyContinue
}
exit $code
