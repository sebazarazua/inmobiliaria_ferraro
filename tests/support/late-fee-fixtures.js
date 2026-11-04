const fixedQuote='Interes simple diario de 0.10% diario sobre saldo de capital impago del alquiler desde el dia siguiente al vencimiento, en dias corridos. Los pagos se imputan primero al capital al inicio del dia. Se incluye el dia de corte.';
const bankQuote='Interes simple diario sobre saldo de capital impago del alquiler desde el dia siguiente al vencimiento, en dias corridos, tasa Banco Nacion cartera general prestamos nominal anual vencida a 30 dias, base 365. Los pagos se imputan primero al capital al inicio del dia. Se incluye el dia de corte.';
function clausePdf(text){
  const words=text.replace(/[()\\]/g,'').split(/\s+/),lines=[''];for(const word of words){if(lines.at(-1).length+word.length>75)lines.push('');lines[lines.length-1]+=(lines.at(-1)?' ':'')+word;}
  const stream='BT /F1 12 Tf 40 740 Td '+lines.map((line,i)=>(i?'0 -16 Td ':'')+`(${line}) Tj`).join(' ')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(body);body+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(body);
}
function pagesPdf(pages){
  const objects=['','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],kids=[];
  for(const text of pages){const pageId=objects.length+1,contentId=pageId+1;kids.push(pageId+' 0 R');const words=text.replace(/[()\\]/g,'').split(/\s+/),lines=[''];for(const word of words){if(lines.at(-1).length+word.length>75)lines.push('');lines[lines.length-1]+=(lines.at(-1)?' ':'')+word;}
    const stream='BT /F1 12 Tf 40 740 Td '+lines.map((line,i)=>(i?'0 -16 Td ':'')+`(${line}) Tj`).join(' ')+' ET';objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[0]='<< /Type /Catalog /Pages 2 0 R >>';objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let body='%PDF-1.4\n',offsets=[];objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${object}\nendobj\n`;});const start=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(body);
}
module.exports={fixedQuote,bankQuote,clausePdf,pagesPdf};
