import 'dotenv/config';
import crypto from 'crypto';
import * as _forge from 'node-forge';
import { initializeConfig, createOrderProposal } from '@temple-digital-group/temple-canton-js';

const forge = _forge.default || _forge;
const API='https://api.templedigitalgroup.com';
const LOOP='https://cantonloop.com';

const PARTY_ID=process.env.PARTY_ID?.trim();
const EMAIL=process.env.EMAIL?.trim();
const PASSWORD=process.env.PASSWORD?.trim();
const SYMBOL=process.env.SYMBOL||'Amulet/USDCx';
const QTY=Number(process.env.TRADE_QTY||40);
const DRY_RUN=String(process.env.DRY_RUN||'false').toLowerCase()==='true';

function key(){const raw=(process.env.PRIVATE_KEYS||process.env.PRIVATE_KEY||'').trim();if(raw.startsWith('['))return String(JSON.parse(raw)[0]);if(raw.includes(','))return raw.split(',')[0].trim();return raw;}
function signer(){const pk=forge.util.hexToBytes(key());const pub=forge.pki.ed25519.publicKeyFromPrivateKey({privateKey:pk});return {pub:forge.util.bytesToHex(pub),sign:(m)=>forge.util.bytesToHex(forge.pki.ed25519.sign({message:m,encoding:'utf8',privateKey:pk})),signTx:(h)=>forge.util.bytesToHex(forge.pki.ed25519.sign({message:forge.util.decode64(h),encoding:'binary',privateKey:pk}))};}
const S=signer();

let _login=null;
async function login(){if(_login) return _login; const r=await fetch(`${API}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});const j=await r.json();if(!r.ok)throw new Error('login fail');_login=j; return j;}
async function tfetch(path,{method='GET',q=null,body=null}={}){const lg=await login();const t=lg.access_token;const u=new URL(`${API}${path}`);if(q)Object.entries(q).forEach(([k,v])=>u.searchParams.set(k,String(v)));const r=await fetch(u,{method,headers:{Authorization:`Bearer ${t}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const txt=await r.text();const j=txt?JSON.parse(txt):{};if(!r.ok)throw new Error(`${method} ${path} ${r.status} ${txt.slice(0,160)}`);return j;}
async function loopSess(){let epoch=Date.now();for(let i=0;i<3;i++){const sig=S.sign(`Exchange API Key for ${PARTY_ID}\nTimestamp: ${epoch}`);const r=await fetch(`${LOOP}/api/v1/.connect/pair/apikey`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({public_key:S.pub,signature:sig,epoch})});const txt=await r.text();if(r.ok)return JSON.parse(txt);if(txt.includes('expired epoch')){const o=await fetch(`${LOOP}/api/v1/.connect/pair/apikey`,{method:'OPTIONS'});epoch=new Date(o.headers.get('date')).getTime();continue;}throw new Error(`loop apikey ${r.status} ${txt}`);}throw new Error('loop apikey failed');}
async function loopActiveContracts(params){const s=await loopSess();const u=new URL(`${LOOP}/api/v1/.connect/pair/account/active-contracts`);if(params?.templateId)u.searchParams.set('templateId',params.templateId);if(params?.interfaceId)u.searchParams.set('interfaceId',params.interfaceId);const r=await fetch(u,{headers:{Authorization:`Bearer ${s.auth_token}`}});if(!r.ok)throw new Error(`active-contracts ${r.status}`);return r.json();}
async function submit(command){const s=await loopSess();const p=await fetch(`${LOOP}/api/v1/.connect/tickets/prepare-transaction`,{method:'POST',headers:{Authorization:`Bearer ${s.api_key}`,'content-type':'application/json'},body:JSON.stringify({payload:command,ticket_id:s.ticket_id})});const pj=await p.json();if(!p.ok||!pj.transaction_hash)throw new Error(`prepare fail ${p.status} ${JSON.stringify(pj).slice(0,180)}`);const sig=S.signTx(pj.transaction_hash);const e=await fetch(`${LOOP}/api/v1/.connect/tickets/execute-transaction`,{method:'POST',headers:{Authorization:`Bearer ${s.api_key}`,'content-type':'application/json'},body:JSON.stringify({ticket_id:s.ticket_id,request_id:crypto.randomUUID(),command_id:pj.command_id,transaction_data:pj.transaction_data,signature:sig})});const ej=await e.json();if(!e.ok)throw new Error(`execute fail ${e.status} ${JSON.stringify(ej).slice(0,180)}`);return ej;}

async function main(){
  if(!PARTY_ID||!EMAIL||!PASSWORD) throw new Error('missing env');
  const tk=await tfetch('/api/public/market/ticker',{q:{symbol:SYMBOL}});
  const last=Number(tk?.ticker?.last_price||0);
  const price=Number((last-0.0001).toFixed(4));
  console.log('last',last,'targetSell',price);

  const d=await tfetch('/api/amulet/disclosures',{q:{partyId:PARTY_ID}});
  const disclosures=d?.disclosures?.choiceContext?.disclosedContracts||[];

  initializeConfig({NETWORK:'mainnet',VALIDATOR_API_URL:'https://api.templedigitalgroup.com',VALIDATOR_SCAN_API_URL:'https://api.templedigitalgroup.com',VALIDATOR_USER_PARTY_ID:PARTY_ID});
  const lg=await login();
  const proposal=await createOrderProposal({party:PARTY_ID,symbol:SYMBOL,side:'Sell',quantity:String(QTY),pricePerUnit:String(price),expiration:new Date(Date.now()+20*60000).toISOString(),orderType:'limit',userId:String(lg?.user?.user_id||'')},true,{getActiveContracts:loopActiveContracts},disclosures);
  if(proposal?.error) throw new Error('proposal: '+proposal.error);
  if(DRY_RUN){console.log('DRY_RUN proposal ready');return;}
  const sub=await submit(proposal.command);
  console.log('submitted',JSON.stringify(sub).slice(0,220));

  await new Promise(r=>setTimeout(r,4000));
  const active=await tfetch('/api/trading/orders/active',{q:{symbol:SYMBOL,limit:50}});
  const list=active.orders||[];
  console.log('active count',list.length);
  const mine=list.find(o=>String(o.side).toLowerCase()==='sell'&&Number(o.price)===price&&Number(o.original_quantity||o.quantity)===QTY) || list.find(o=>String(o.side).toLowerCase()==='sell');
  if(!mine){console.log('no sell order found to cancel');return;}
  console.log('canceling order',mine.order_id,'price',mine.price,'qty',mine.original_quantity||mine.quantity);
  const c=await tfetch(`/api/trading/orders/${encodeURIComponent(mine.order_id)}/cancel`,{method:'POST'});
  console.log('cancel result',JSON.stringify(c));
}

main().catch(e=>{console.error('FAILED',e.message);process.exit(1);});
