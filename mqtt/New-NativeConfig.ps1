param([string]$BindAddress = '127.0.0.1', [int]$Port = 1883)
$ErrorActionPreference = 'Stop'
if ($BindAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or $Port -lt 1 -or $Port -gt 65535) { throw 'Supply an IPv4 bind address and valid port.' }
$secrets = Join-Path $PSScriptRoot '.secrets'
if (!(Test-Path -LiteralPath (Join-Path $secrets 'password_file'))) { throw 'Run Initialize-MqttAuth.ps1 first.' }
$data = Join-Path $secrets 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$passwordFile = (Join-Path $secrets 'password_file').Replace('\','/')
$aclFile = (Join-Path $PSScriptRoot 'acl.example').Replace('\','/')
$dataPath = $data.Replace('\','/') + '/'
$config = @("listener $Port $BindAddress",'allow_anonymous false',"password_file $passwordFile", "acl_file $aclFile",'persistence true',"persistence_location $dataPath",'autosave_interval 60','max_packet_size 65536','log_dest stdout','log_type notice','log_type warning','log_type error')
[IO.File]::WriteAllLines((Join-Path $secrets 'mosquitto.native.conf'), $config, (New-Object Text.UTF8Encoding $false))
Write-Output 'Created ignored mqtt/.secrets/mosquitto.native.conf. Start only one broker per port.'
