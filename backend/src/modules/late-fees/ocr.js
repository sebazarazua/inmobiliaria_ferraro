const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
// Optional local executables, explicitly enabled by the administrator. No document is uploaded.
async function ocrPage(file,page,{run=promisify(execFile)}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-mora-ocr-'));
  try{
    const prefix=path.join(directory,'page');
    await run('pdftoppm',['-f',String(page),'-l',String(page),'-r','150','-singlefile','-png',file,prefix],{timeout:30000,maxBuffer:1024*1024});
    const {stdout}=await run('tesseract',[prefix+'.png','stdout','-l','spa'],{timeout:30000,maxBuffer:1024*1024});
    return String(stdout).trim();
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
module.exports={ocrPage};
