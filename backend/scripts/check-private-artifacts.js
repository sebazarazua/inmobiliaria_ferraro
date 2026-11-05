const {spawnSync}=require('node:child_process');
const result=spawnSync('git',['ls-files','-z'],{encoding:'utf8'});
if(result.status!==0){console.error('No se pudo comprobar el índice de Git.');process.exitCode=1;}
else{
  const files=result.stdout.split('\0').filter(Boolean),blocked=files.filter(file=>/^(?:\.playwright-cli|contratos|temp|tmp)\//.test(file)||/\.pdf$|\.dump$|\.sqlite(?:3)?$|\.(?:bak|backup)$/i.test(file)||/(?:^|\/)\.DS_Store$/.test(file)||/(?:^|\/)\.env(?:\.|$)/.test(file)&&!/(?:\.example|\.sample)$/.test(file));
  // .DS_Store lists the names of the files in its folder, which can identify real contracts.
  if(blocked.length){console.error(`Privacidad: ${blocked.length} artefacto(s) privado(s) están en el índice de Git. Retiralos del seguimiento conservando los originales locales; revisá el historial por separado.`);process.exitCode=1;}
  else console.log('Privacidad: sin PDFs, entornos privados ni artefactos de cartera en el índice de Git.');
}
