require('../src/modules/late-fees/ocr').ocrDiagnostics({enabled:true}).then(r=>{
  if(!r.available)throw new Error('CI requiere OCR nativo: faltan '+r.missing.join(', '));
  console.log('OCR nativo disponible: Poppler, Tesseract y español. La prueba E10 debe ejecutarse.');
}).catch(e=>{console.error(e.message);process.exitCode=1;});
