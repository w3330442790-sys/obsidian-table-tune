param([Parameter(Mandatory=$true)][string]$PluginDir)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$targetRoot=(Resolve-Path -LiteralPath $PluginDir).Path
$installed=Get-Content -LiteralPath (Join-Path $targetRoot 'manifest.json') -Raw | ConvertFrom-Json
$built=Get-Content -LiteralPath (Join-Path $projectRoot 'dist\table-tune\manifest.json') -Raw | ConvertFrom-Json
if ($installed.id -ne 'table-tune' -or $built.id -ne 'table-tune') { throw 'Unexpected plugin ID; replacement cancelled.' }
if ([version]$installed.version -ge [version]$built.version) { throw 'Built version must be newer than installed version; replacement cancelled.' }
$programFiles=@('main.js','styles.css','manifest.json')
$dataPath=Join-Path $targetRoot 'data.json'
$beforeDataHash=if(Test-Path -LiteralPath $dataPath){(Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash}else{$null}
$backupRoot=Join-Path $projectRoot ('private\install-backups\'+(Get-Date -Format yyyy-MM-dd)+'-table-tune-'+[guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
foreach($name in ($programFiles+@('data.json'))){$source=Join-Path $targetRoot $name;if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $backupRoot $name)}}
$report=@{oldVersion=$installed.version;newVersion=$built.version;target=$targetRoot;backup=$backupRoot;programFiles=@();dataUnchanged=$false}
try{
 foreach($name in $programFiles){
  $source=Join-Path $projectRoot ('dist\table-tune\'+$name)
  $pending=Join-Path $targetRoot ($name+'.table-tools-pending')
  Copy-Item -LiteralPath $source -Destination $pending -Force
  Move-Item -LiteralPath $pending -Destination (Join-Path $targetRoot $name) -Force
  if((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath (Join-Path $targetRoot $name)).Hash){throw ('Hash mismatch: '+$name)}
  $report.programFiles+=$name
 }
 $afterDataHash=if(Test-Path -LiteralPath $dataPath){(Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash}else{$null}
 $report.dataUnchanged=($beforeDataHash -eq $afterDataHash)
 if(-not $report.dataUnchanged){throw 'data.json changed concurrently; installer never writes this file.'}
 $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot 'replacement-report.json') -Encoding utf8
 $report | ConvertTo-Json -Depth 5
}catch{
 foreach($name in $programFiles){$old=Join-Path $backupRoot $name;if(Test-Path -LiteralPath $old){Copy-Item -LiteralPath $old -Destination (Join-Path $targetRoot $name) -Force}}
 throw
}
