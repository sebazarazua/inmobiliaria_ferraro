// POSIX mode bits do not represent Windows ACLs. Never treat 0600 as proof of NTFS privacy.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const ACL_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$a = Get-Acl -LiteralPath $env:FERRARO_PRIVATE_PATH
$sid = [System.Security.Principal.SecurityIdentifier]
$rules = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object {
  @{sid=$_.IdentityReference.Value; allow=($_.AccessControlType -eq 'Allow'); rights=[int]$_.FileSystemRights; inherit_only=(($_.PropagationFlags -band 2) -ne 0)}
})
@{owner=$a.GetOwner($sid).Value; current_user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; canonical=$a.AreAccessRulesCanonical; rules=$rules} | ConvertTo-Json -Compress -Depth 5
`;
function privateWindowsAcl(acl){
  if(!acl||!acl.current_user||acl.owner!==acl.current_user||acl.canonical!==true||!Array.isArray(acl.rules)||!acl.rules.length)return false;
  const allowed=new Set([acl.current_user,'S-1-5-18','S-1-5-32-544']); // Operator, SYSTEM and local Administrators.
  return acl.rules.some(r=>r.allow===true&&r.sid===acl.current_user&&r.rights>0)&&acl.rules.every(r=>
    r.allow===false||(r.allow===true&&Number.isInteger(r.rights)&&r.rights>0&&(allowed.has(r.sid)||(r.sid==='S-1-3-0'&&r.inherit_only===true))));
}
function readWindowsAcl(file){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ACL_SCRIPT],{env:{...process.env,FERRARO_PRIVATE_PATH:file},encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
  if(result.status!==0)throw new Error('No se pudo verificar la ACL privada de Windows. Revisá permisos NTFS con el operador; no se omite esta protección.');
  try{return JSON.parse(result.stdout.replace(/^\uFEFF/,''));}catch{throw new Error('Windows no devolvió una ACL verificable.');}
}
function assertPrivatePath(file,{directory=false,platform=process.platform,readAcl=readWindowsAcl}={}){
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))throw new Error('La ruta privada no admite enlaces ni otro tipo de archivo.');
  if(platform==='win32'){
    if(!privateWindowsAcl(readAcl(file)))throw new Error('La ruta privada de Windows debe pertenecer al operador y permitir acceso sólo a ese usuario, SYSTEM y Administradores. Revisá su ACL; no se cambia automáticamente.');
  }else if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw new Error('La ruta debe ser privada y pertenecer al operador.');
  return stat;
}
module.exports={assertPrivatePath,privateWindowsAcl};
