import 'dotenv/config';
import { getSigner } from '../node_modules/@fivenorth/loop-sdk/dist/server/signer.js';

function parseKey(raw){
  const v=(raw||'').trim();
  if(!v) throw new Error('Missing PRIVATE_KEY/PRIVATE_KEYS');
  try{ if(v.startsWith('[')) return String(JSON.parse(v)[0]).trim(); }catch{}
  if(v.includes(',')) return v.split(',')[0].trim();
  return v;
}
function toNum(x){ const n=Number(x); return Number.isFinite(n)?n:0; }

const partyId=process.env.PARTY_ID?.trim();
const signer=getSigner(parseKey(process.env.PRIVATE_KEYS||process.env.PRIVATE_KEY), partyId);

async function getAuthToken(){
  const url='https://cantonloop.com/api/v1/.connect/pair/apikey';
  for (let i=0;i<3;i++) {
    const epoch = i===0 ? Date.now() : new Date((await fetch(url,{method:'OPTIONS'})).headers.get('date')).getTime();
    const signature = signer.signMessageAsHex(`Exchange API Key for ${partyId}\nTimestamp: ${epoch}`);
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({public_key:signer.getPublicKey(),signature,epoch})});
    const txt=await r.text();
    if (r.ok) return JSON.parse(txt).auth_token;
    if (!txt.includes('expired epoch')) throw new Error(`apikey failed: ${r.status} ${txt}`);
  }
  throw new Error('apikey failed: expired epoch');
}

const authToken = await getAuthToken();
const res = await fetch('https://cantonloop.com/api/v1/.connect/pair/account/holding', { headers: { Authorization: `Bearer ${authToken}` } });
if(!res.ok) throw new Error(`holding failed ${res.status} ${await res.text()}`);
const holdings=await res.json();

const find=(id)=>holdings.find(h=>String(h?.instrument_id?.id||'').toUpperCase()===id.toUpperCase());
const amulet=find('Amulet');
const usdcx=find('USDCx');

const out={
  ok:true,
  partyId,
  balances:{
    CC_unlocked: toNum(amulet?.total_unlocked_coin),
    CC_locked: toNum(amulet?.total_locked_coin),
    USDCx_unlocked: toNum(usdcx?.total_unlocked_coin),
    USDCx_locked: toNum(usdcx?.total_locked_coin),
  }
};
console.log(JSON.stringify(out,null,2));
