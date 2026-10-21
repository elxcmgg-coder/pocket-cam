param([Parameter(Mandatory = $true)][string]$LanIP)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$parsedIP = $null
if (-not [System.Net.IPAddress]::TryParse($LanIP, [ref]$parsedIP) -or $parsedIP.AddressFamily -ne 'InterNetwork') {
    throw 'Please provide the PC LAN IPv4 address, for example 192.168.1.25.'
}
$mkcertCommand = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcertCommand) { throw 'Install mkcert from https://github.com/FiloSottile/mkcert first, then reopen this terminal.' }
Write-Host 'This creates a local CA and adds it to this Windows user trust store.'
Write-Host 'The iPhone CA trust step must be completed manually. Never share rootCA-key.pem.'
if ((Read-Host 'Type YES to continue') -cne 'YES') { return }
New-Item -ItemType Directory -Force -Path 'certs' | Out-Null
& $mkcertCommand.Source -install
if ($LASTEXITCODE -ne 0) { throw 'mkcert CA installation failed.' }
& $mkcertCommand.Source -cert-file 'certs/server.pem' -key-file 'certs/server-key.pem' localhost 127.0.0.1 $LanIP
if ($LASTEXITCODE -ne 0) { throw 'Certificate generation failed.' }
$caDirectory = & $mkcertCommand.Source -CAROOT
if ($LASTEXITCODE -ne 0) { throw 'Cannot find CA directory.' }
Copy-Item -LiteralPath (Join-Path $caDirectory 'rootCA.pem') -Destination 'certs/PocketCam-CA.crt'
Write-Host "iPhone Safari URL: https://${LanIP}:8443/?mode=phone"
Write-Host 'Transfer only certs/PocketCam-CA.crt to your iPhone through a trusted channel.'
Write-Host 'Follow README to install and enable full trust for this CA, then run Start-PocketCam.cmd.'
