const crypto=require('node:crypto');

function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

function timingSafeEqualText(left='',right=''){
  const a=Buffer.from(String(left));
  const b=Buffer.from(String(right));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

function verifyMetaSignature(rawBody,header,secret){
  if(!secret)return false;
  const expected=`sha256=${crypto.createHmac('sha256',secret).update(rawBody).digest('hex')}`;
  return timingSafeEqualText(expected,header||'');
}

function strongToken(length=32){return crypto.randomBytes(length).toString('base64url');}

module.exports={sha256,timingSafeEqualText,verifyMetaSignature,strongToken};
