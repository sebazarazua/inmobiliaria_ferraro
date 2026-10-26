const {html,page}=require('../lib/pages');

module.exports=async function handler(req,res){
  if(req.method!=='GET'){
    res.statusCode=405;
    res.setHeader('Allow','GET');
    return res.end('Method not allowed');
  }
  return html(res,200,page({
    title:'Eliminacion de Datos',
    description:'Instrucciones para solicitar la eliminacion de datos asociados a comunicaciones por WhatsApp con Eugenio A. Ferraro Propiedades.',
    sections:[
      {
        title:'Como solicitarla',
        body:'<p>Para pedir la eliminacion de datos personales vinculados a comunicaciones por WhatsApp, enviar un correo a <a href="mailto:sebazarazua@gmail.com">sebazarazua@gmail.com</a> indicando el numero de telefono utilizado y una descripcion breve de la solicitud.</p>'
      },
      {
        title:'Validacion',
        body:'<p>Podremos solicitar informacion adicional razonable para verificar la identidad del solicitante y evitar accesos o eliminaciones no autorizadas.</p>'
      },
      {
        title:'Alcance',
        body:'<p>La solicitud sera evaluada conforme a la normativa aplicable en Argentina y a las obligaciones legales, contables o contractuales que pudieran requerir conservar determinada informacion.</p>'
      },
      {
        title:'Proveedores',
        body:'<p>Meta/WhatsApp y proveedores tecnicos pueden conservar o procesar datos segun sus propias politicas y obligaciones. Ferraro gestionara la informacion bajo su control directo.</p>'
      }
    ]
  }));
};
