const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
// Optional local executables, explicitly enabled by the administrator. No document is uploaded.
const TIMEOUT_MS=30000,MAX_OUTPUT=1024*1024,LANGUAGE='spa';
const MESSAGES={
  missing_executable:'Falta un ejecutable de OCR local (Poppler «pdftoppm» o Tesseract).',
  missing_language:'Tesseract no tiene instalado el idioma español («spa»).',
  unreadable_pdf:'El PDF no se pudo rasterizar: puede estar dañado o protegido.',
  timeout:'El OCR superó el tiempo máximo permitido.',
  processing_error:'El OCR local falló al procesar la página.'
};
function ocrError(kind,cause){const error=new Error(MESSAGES[kind]);error.kind=kind;error.detail=String(cause?.stderr||cause?.message||'').slice(0,300);return error;}
function classify(error,stage){
  if(error.code==='ENOENT')return ocrError('missing_executable',error);
  if(error.killed||error.signal==='SIGTERM'||error.code==='ETIMEDOUT')return ocrError('timeout',error);
  const stderr=String(error.stderr||error.message||'');
  if(stage==='tesseract'&&/load(?:ing)? language|traineddata/i.test(stderr))return ocrError('missing_language',error);
  if(stage==='pdftoppm')return ocrError('unreadable_pdf',error);
  return ocrError('processing_error',error);
}
async function ocrPage(file,page,{run=promisify(execFile)}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-mora-ocr-'));
  try{
    const prefix=path.join(directory,'page');
    try{await run('pdftoppm',['-f',String(page),'-l',String(page),'-r','150','-singlefile','-png',file,prefix],{timeout:TIMEOUT_MS,maxBuffer:MAX_OUTPUT});}catch(e){throw classify(e,'pdftoppm');}
    let stdout;
    try{({stdout}=await run('tesseract',[prefix+'.png','stdout','-l',LANGUAGE],{timeout:TIMEOUT_MS,maxBuffer:MAX_OUTPUT}));}catch(e){throw classify(e,'tesseract');}
    return String(stdout).trim();
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
// Reports what is installed without processing any document.
async function ocrDiagnostics({run=promisify(execFile),enabled=process.env.LATE_FEE_OCR==='true'}={}){
  const probe=async(command,args)=>{try{const r=await run(command,args,{timeout:10000,maxBuffer:MAX_OUTPUT});return{ok:true,output:`${r.stdout||''}${r.stderr||''}`};}catch(e){return{ok:false,output:`${e.stdout||''}${e.stderr||''}`,missing:e.code==='ENOENT'};}};
  const poppler=await probe('pdftoppm',['-v']),tesseract=await probe('tesseract',['--version']);
  // pdftoppm -v exits non-zero on some versions while printing its version.
  const popplerOk=poppler.ok||(!poppler.missing&&/pdftoppm|poppler/i.test(poppler.output));
  const langs=tesseract.ok?await probe('tesseract',['--list-langs']):{ok:false,output:''};
  const languages=langs.output.split(/\r?\n/).map(l=>l.trim()).filter(l=>/^[a-z_]{3,}$/i.test(l));
  const missing=[...(popplerOk?[]:['pdftoppm']),...(tesseract.ok?[]:['tesseract']),...(tesseract.ok&&!languages.includes(LANGUAGE)?['tesseract-spa']:[])];
  return{enabled,available:!missing.length,missing,languages,
    message:missing.length?`OCR local no disponible: falta ${missing.join(', ')}. En macOS: «brew install poppler tesseract tesseract-lang» y LATE_FEE_OCR=true.`:enabled?'OCR local disponible y habilitado.':'OCR local instalado pero deshabilitado (definí LATE_FEE_OCR=true para usarlo).'};
}
module.exports={ocrPage,ocrDiagnostics,MESSAGES};
