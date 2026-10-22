param([string]$MosquittoDirectory = 'C:\Program Files\mosquitto')
$ErrorActionPreference = 'Stop'
$secrets = Join-Path $PSScriptRoot '.secrets'
$passwordFile = Join-Path $secrets 'password_file'
if (Test-Path -LiteralPath $secrets) { throw 'mqtt/.secrets already exists. Refusing to overwrite credentials.' }
$tool = Join-Path $MosquittoDirectory 'mosquitto_passwd.exe'
if (!(Test-Path -LiteralPath $tool)) { throw 'Set -MosquittoDirectory to the installed Mosquitto tools.' }
New-Item -ItemType Directory -Path (Join-Path $secrets 'health') -Force | Out-Null
$credentials = @{}
foreach ($user in @('backend','esp32_main_01','esp32_cam_01','simulator')) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes); $rng.Dispose()
  $credentials[$user] = [Convert]::ToBase64String($bytes)
}
# -U hashes the temporary file in place. No password appears in process arguments.
$lines = foreach ($user in $credentials.Keys) { '{0}:{1}' -f $user,$credentials[$user] }
[IO.File]::WriteAllLines($passwordFile, $lines, (New-Object Text.UTF8Encoding $false))
& $tool -H sha512-pbkdf2 -U $passwordFile
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $passwordFile; throw 'Password hashing failed; broker must not be started.' }
$envLines = @('MQTT_USERNAME=backend', ('MQTT_PASSWORD={0}' -f $credentials['backend']))
[IO.File]::WriteAllLines((Join-Path $secrets 'backend.env'), $envLines, (New-Object Text.UTF8Encoding $false))
$privateLines = foreach ($user in $credentials.Keys) { '{0}={1}' -f $user,$credentials[$user] }
[IO.File]::WriteAllLines((Join-Path $secrets 'device-credentials.txt'), $privateLines, (New-Object Text.UTF8Encoding $false))
$health = @('-u backend', ('-P {0}' -f $credentials['backend']))
[IO.File]::WriteAllLines((Join-Path $secrets 'health/mosquitto_sub'), $health, (New-Object Text.UTF8Encoding $false))
Write-Output 'Created ignored mqtt/.secrets credentials and hashed password_file. No credentials printed.'
