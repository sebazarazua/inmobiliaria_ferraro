// Read-only, sanitized inventory of private artifacts anywhere in Git history.
// Never prints file names (they can contain addresses or names): only folders, lengths and commits.
const {spawnSync}=require('node:child_process');
const git=args=>{const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw new Error(`git ${args[0]} falló`);return r.stdout;};
const categories=[
  ['PDF de contratos u otros documentos',/\.pdf$/i],
  ['Snapshots de navegador',/^\.playwright-cli\//],
  ['Carpetas temporales',/^(?:tmp|temp)\//],
  ['Metadatos de carpeta (.DS_Store)',/(?:^|\/)\.DS_Store$/],
  ['Entornos privados (.env)',/(?:^|\/)\.env(?:\.(?!example$|sample$)[^/]*)?$/],
  ['Copias de base de datos',/\.(?:dump|sqlite3?|bak|backup)$/i]
];
const found=new Map(categories.map(([name])=>[name,new Map()]));let commit=null;
for(const line of git(['log','--all','--name-only','--format=@@%h']).split('\n')){
  if(line.startsWith('@@')){commit=line.slice(2);continue;}
  if(!line)continue;
  for(const [name,rx] of categories)if(rx.test(line)){const map=found.get(name);if(!map.has(line))map.set(line,new Set());map.get(line).add(commit);}
}
let total=0;
for(const [name,map] of found){
  const commits=new Set([...map.values()].flatMap(set=>[...set]));total+=map.size;
  console.log(`${name}: ${map.size} ruta(s) en ${commits.size} commit(s)${commits.size?` · ${[...commits].join(' ')}`:''}`);
  for(const file of map.keys()){const folder=file.includes('/')?file.slice(0,file.lastIndexOf('/')+1):'';const base=file.slice(folder.length);console.log(`  ${folder}[nombre de ${base.length} caracteres]${base.includes('.')?base.slice(base.lastIndexOf('.')):''}`);}
}
console.log(total?'Hay artefactos privados en el historial: requieren saneamiento coordinado (ver docs/PRIVACIDAD_HISTORIAL_GIT.md).':'Sin artefactos privados detectados en el historial.');
process.exitCode=0;
