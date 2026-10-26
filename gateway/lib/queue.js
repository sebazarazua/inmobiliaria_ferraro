const {command,pipeline}=require('./redis');
const {sha256,strongToken}=require('./crypto');

const PREFIX=process.env.QUEUE_PREFIX||'ferraro:whatsapp';
const PENDING=`${PREFIX}:pending`;
const PROCESSING=`${PREFIX}:processing`;
const DEAD=`${PREFIX}:dead`;
const IDS=`${PREFIX}:ids`;
const DEFAULT_RETENTION_SECONDS=Number(process.env.QUEUE_RETENTION_SECONDS||7*24*60*60);
const DEFAULT_LEASE_SECONDS=Number(process.env.QUEUE_LEASE_SECONDS||120);
const DEFAULT_MAX_ATTEMPTS=Number(process.env.QUEUE_MAX_ATTEMPTS||8);

function eventKey(id){return `${PREFIX}:event:${id}`;}

function minimalMessage(message={},value={}){
  const type=message.type||'text';
  const item={from:message.from,id:message.id,type,timestamp:message.timestamp};
  if(message.text?.body)item.text={body:message.text.body};
  if(message.button?.text)item.button={text:message.button.text};
  if(message.interactive?.button_reply)item.interactive={button_reply:{id:message.interactive.button_reply.id,title:message.interactive.button_reply.title}};
  if(message.interactive?.list_reply)item.interactive={list_reply:{id:message.interactive.list_reply.id,title:message.interactive.list_reply.title}};
  const contact=value.contacts?.find(candidate=>candidate.wa_id===message.from);
  return {
    id:`message:${message.id}`,
    payload:{entry:[{changes:[{value:{contacts:contact?[{wa_id:contact.wa_id,profile:{name:contact.profile?.name||''}}]:[],messages:[item]}}]}]}
  };
}

function minimalStatus(status={}){
  return {
    id:`status:${status.id}:${status.status||''}:${status.timestamp||''}`,
    payload:{entry:[{changes:[{value:{statuses:[{id:status.id,recipient_id:status.recipient_id,status:status.status,timestamp:status.timestamp,errors:(status.errors||[]).map(error=>({code:error.code,title:error.title}))}]}}]}]}
  };
}

function extractEvents(payload){
  const events=[];
  for(const entry of payload.entry||[])for(const change of entry.changes||[]){
    const value=change.value||{};
    for(const message of value.messages||[])if(message.id)events.push(minimalMessage(message,value));
    for(const status of value.statuses||[])if(status.id)events.push(minimalStatus(status));
  }
  return events;
}

async function enqueuePayload(payload,meta={}){
  const events=extractEvents(payload),createdAt=new Date().toISOString(),accepted=[];
  for(const event of events){
    const envelope={id:event.id,payload:event.payload,payloadHash:sha256(JSON.stringify(event.payload)),createdAt,attempts:0,state:'pending',source:'meta',meta};
    const id=event.id;
    const inserted=await command(['SADD',IDS,id]);
    if(!inserted)continue;
    await pipeline([
      ['SET',eventKey(id),JSON.stringify(envelope),'EX',DEFAULT_RETENTION_SECONDS],
      ['RPUSH',PENDING,id]
    ]);
    accepted.push(id);
  }
  return{accepted,duplicates:events.length-accepted.length,ignored:events.length?0:1};
}

async function sweepExpiredLeases(now=Date.now()){
  const ids=await command(['LRANGE',PROCESSING,0,199])||[];
  let requeued=0;
  for(const id of ids){
    const raw=await command(['GET',eventKey(id)]);
    if(!raw){await command(['LREM',PROCESSING,0,id]);continue;}
    const event=JSON.parse(raw);
    if(event.state==='processing'&&Number(event.leaseUntil||0)<=now){
      event.state='pending';
      event.leaseToken=null;
      event.leaseUntil=null;
      await pipeline([
        ['SET',eventKey(id),JSON.stringify(event),'EX',DEFAULT_RETENTION_SECONDS],
        ['LREM',PROCESSING,0,id],
        ['RPUSH',PENDING,id]
      ]);
      requeued+=1;
    }
  }
  return requeued;
}

async function claimEvents(limit=5){
  await sweepExpiredLeases();
  const events=[];
  for(let index=0;index<Math.max(1,Math.min(25,Number(limit)||5));index+=1){
    const id=await command(['RPOPLPUSH',PENDING,PROCESSING]);
    if(!id)break;
    const raw=await command(['GET',eventKey(id)]);
    if(!raw){await command(['LREM',PROCESSING,0,id]);continue;}
    const event=JSON.parse(raw);
    const now=Date.now();
    if(event.retryAfter&&Number(event.retryAfter)>now){
      await pipeline([['LREM',PROCESSING,0,id],['LPUSH',PENDING,id]]);
      break;
    }
    if(event.state==='processed'){await command(['LREM',PROCESSING,0,id]);continue;}
    if(Number(event.attempts||0)>=DEFAULT_MAX_ATTEMPTS){
      event.state='dead';
      event.deadAt=new Date().toISOString();
      await pipeline([
        ['SET',eventKey(id),JSON.stringify(event),'EX',DEFAULT_RETENTION_SECONDS],
        ['LREM',PROCESSING,0,id],
        ['RPUSH',DEAD,id]
      ]);
      continue;
    }
    const leaseToken=strongToken(24);
    event.state='processing';
    event.attempts=Number(event.attempts||0)+1;
    event.leaseToken=leaseToken;
    event.leaseUntil=now+DEFAULT_LEASE_SECONDS*1000;
    await command(['SET',eventKey(id),JSON.stringify(event),'EX',DEFAULT_RETENTION_SECONDS]);
    events.push({id,leaseToken,attempts:event.attempts,payload:event.payload,createdAt:event.createdAt});
  }
  return events;
}

async function ackEvent(id,leaseToken){
  const raw=await command(['GET',eventKey(id)]);
  if(!raw)return{ok:true,missing:true};
  const event=JSON.parse(raw);
  if(event.leaseToken&&event.leaseToken!==leaseToken){
    const error=new Error('Lease token invalido.');
    error.status=409;
    throw error;
  }
  await pipeline([['LREM',PROCESSING,0,id],['DEL',eventKey(id)],['SREM',IDS,id]]);
  return{ok:true};
}

async function nackEvent(id,leaseToken,errorMessage=''){
  const raw=await command(['GET',eventKey(id)]);
  if(!raw)return{ok:true,missing:true};
  const event=JSON.parse(raw);
  if(event.leaseToken&&event.leaseToken!==leaseToken){
    const error=new Error('Lease token invalido.');
    error.status=409;
    throw error;
  }
  const delaySeconds=Math.min(15*60,Math.max(5,2**Math.min(10,Number(event.attempts||1))));
  event.state='pending';
  event.leaseToken=null;
  event.leaseUntil=null;
  event.retryAfter=Date.now()+delaySeconds*1000;
  event.lastError=String(errorMessage||'Error local').slice(0,500);
  await pipeline([
    ['SET',eventKey(id),JSON.stringify(event),'EX',DEFAULT_RETENTION_SECONDS],
    ['LREM',PROCESSING,0,id],
    ['RPUSH',PENDING,id]
  ]);
  return{ok:true,retryAfter:event.retryAfter};
}

async function queueStats(){
  const result=await pipeline([
    ['LLEN',PENDING],
    ['LLEN',PROCESSING],
    ['LLEN',DEAD],
    ['SCARD',IDS]
  ]);
  return{pending:result[0]?.result||0,processing:result[1]?.result||0,dead:result[2]?.result||0,known_ids:result[3]?.result||0};
}

module.exports={enqueuePayload,claimEvents,ackEvent,nackEvent,queueStats};
