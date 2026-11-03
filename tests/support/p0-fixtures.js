// Synthetic PDF and fictional people only. No production files are written by these tests.
function pdf(text='Contrato de prueba para revision IPC'){
  const stream=`BT /F1 12 Tf 40 740 Td (${text.replace(/[()\\]/g,'')}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(body);body+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(body);
}
const review={address:'Prueba Documental 140',property_type:'Departamento',rental_type:'Residencial',owner_full_name:'Propietaria Prueba',owner_document_number:'20900111',tenant_full_name:'Inquilina Prueba',tenant_document_number:'40900222',start_date:'2026-01-01',end_date:'2027-12-31',duration_months:24,initial_amount:500000,currency:'ARS',adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:3,ipc_lag_months:1,payment_due_day:10,guarantee_type:'Sin garantía',guarantee_provider:'Respaldar',ipc_clause_text:'IPC trimestral con un mes de rezago.',ipc_clause_confirmed:true};
module.exports={pdf,review};
