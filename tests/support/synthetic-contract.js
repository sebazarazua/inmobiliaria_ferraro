const fs=require('node:fs'),path=require('node:path');
const {clausePdf}=require('./late-fee-fixtures');
function sampleContract(){
  if(process.env.FERRARO_TEST_ISOLATED!=='1'||!process.env.FERRARO_TEST_IMPORT_DIRECTORY)throw new Error('La muestra requiere el runner aislado.');
  const file=path.join(path.dirname(process.env.FERRARO_TEST_IMPORT_DIRECTORY),'CONTRATO VIVIENDA. CALLE PRUEBA 101 CON SEGURO 2024.pdf');
  const text='CONTRATO DE LOCACION DE VIVIENDA. DATOS COMPLETAMENTE FICTICIOS PARA PRUEBAS. Entre la Sra. Alicia Ejemplo, DNI ficticio 99000101 y el Sr. Bruno Modelo, DNI ficticio 99000102, por la otra parte el Sr. Carlos Sintetico, DNI ficticio 99000103, convienen en celebrar contrato. PRIMERA: El locador da en locacion el inmueble sito en Calle Prueba 101, destinado a vivienda. SEGUNDA: El plazo es de (12) meses, comenzando el dia 1 de JUNIO de 2026 hasta el dia 31 de MAYO de 2027. TERCERA: Canon mensual de $420.000 en pesos, ajuste CUATRIMESTRAL IPC, entre los dias 1 y 10 de cada mes. Deposito de garantia de $420.000. Banco Ejemplo, CBU 0000000000000000000000. CUARTA: Seguro de caucion GARANTIA SEGURA SRL (Proveedor Ficticio). QUINTA: Agua, gas y expensas. SEXTA: Mora de 0,10% diario desde el dia siguiente al vencimiento.';
  fs.writeFileSync(file,clausePdf(text));return file;
}
module.exports={sampleContract};
