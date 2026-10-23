param([string]$DatabaseName='rbrick')
$ErrorActionPreference='Stop'
if($DatabaseName -notmatch '^[A-Za-z0-9_-]{1,63}$'){throw 'Invalid database name'}
$directory=Join-Path $PSScriptRoot '.secrets'
if(Test-Path -LiteralPath $directory){throw 'Local secrets already exist; refusing to replace persisted database credentials'}
New-Item -ItemType Directory -Path $directory | Out-Null
function New-Secret([int]$Length=32) {
  $bytes=New-Object byte[] $Length
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes);$rng.Dispose()
  return [Convert]::ToBase64String($bytes)
}
function Save-Secret([string]$Name,[string]$Value) {
  [IO.File]::WriteAllText((Join-Path $directory $Name),$Value,(New-Object Text.UTF8Encoding $false))
}
$rootPassword=New-Secret
$appPassword=New-Secret
Save-Secret 'mongo_root_username' 'rbrick_root'
Save-Secret 'mongo_root_password' $rootPassword
Save-Secret 'mongo_app_password' $appPassword
Save-Secret 'mongo_keyfile' (New-Secret 756)
$encoded=[uri]::EscapeDataString($appPassword)
$uri='mongodb://rbrick_app:{0}@mongo:27017/?replicaSet=rs0&authSource={1}' -f $encoded,$DatabaseName
$lines=@("DB_NAME=$DatabaseName", "LOCAL_MONGODB_URI=$uri",('IOT_API_TOKEN='+ (New-Secret)),('AI_SERVICE_TOKEN='+ (New-Secret)))
[IO.File]::WriteAllLines((Join-Path $directory 'local.env'),$lines,(New-Object Text.UTF8Encoding $false))
$mqtt=Join-Path (Split-Path $PSScriptRoot -Parent) 'mqtt/Initialize-MqttAuth.ps1'
if(!(Test-Path -LiteralPath (Join-Path (Split-Path $mqtt -Parent) '.secrets/password_file'))){& $mqtt}
Write-Output 'Created ignored local database/API credentials. Existing .env and MQTT credentials were preserved.'
