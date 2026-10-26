const {html,page}=require('../lib/pages');

module.exports=async function handler(req,res){
  if(req.method!=='GET'){
    res.statusCode=405;
    res.setHeader('Allow','GET');
    return res.end('Method not allowed');
  }
  return html(res,200,page({
    title:'Politica de Privacidad',
    description:'Eugenio A. Ferraro Propiedades',
    sections:[
      {
        title:'Uso de WhatsApp',
        body:'<p>Utilizamos WhatsApp para atender consultas y brindar servicios relacionados con la administracion inmobiliaria, incluyendo comunicaciones solicitadas por propietarios y gestiones vinculadas a inmuebles administrados.</p>'
      },
      {
        title:'Datos que pueden procesarse',
        body:'<p>Para prestar el servicio podemos procesar el numero de telefono, nombre o perfil de WhatsApp, contenido de mensajes y datos necesarios para identificar al propietario y responder su consulta.</p>'
      },
      {
        title:'Finalidad',
        body:'<p>Los datos se utilizan unicamente para prestar el servicio, gestionar las comunicaciones solicitadas, registrar interacciones necesarias y responder consultas vinculadas con la administracion inmobiliaria.</p>'
      },
      {
        title:'Comparticion y proveedores',
        body:'<p>No vendemos datos personales. Meta/WhatsApp y proveedores tecnicos pueden procesar datos necesarios para transportar, proteger y operar las comunicaciones.</p>'
      },
      {
        title:'Infraestructura privada',
        body:'<p>La informacion privada del sistema inmobiliario, contratos, liquidaciones y base PostgreSQL permanecen en la infraestructura privada/local de Ferraro. Esta pagina no expone ni permite consultar esa informacion.</p>'
      },
      {
        title:'Derechos de las personas',
        body:'<p>Las personas pueden solicitar acceso, rectificacion o eliminacion de sus datos personales cuando corresponda. Para ejercer estos derechos, escribir a <a href="mailto:sebazarazua@gmail.com">sebazarazua@gmail.com</a>.</p>'
      }
    ]
  }));
};
