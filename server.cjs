// Dependency-free shared marketplace server. Run with Node.js 20 or newer.
'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const root=__dirname;
const dataDir=process.env.MARKET_DATA_DIR||path.join(root,'data');
const dataFile=path.join(dataDir,'listings.json');
const categories=new Set(['gpu','parts','laptop','screen','gaming','mobile','other']);
const conditions=new Set(['كالجديد','مستعمل بحالة ممتازة','مستعمل بحالة جيدة','يحتاج إصلاح']);
const maxBody=2*1024*1024;
let listings=[],queue=Promise.resolve();
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
const publicListing=({ownerHash,...listing})=>listing;
const fail=(status,message)=>Object.assign(new Error(message),{status});
function text(value,min,max){return typeof value==='string'&&value.trim().length>=min&&value.trim().length<=max;}
function validate(data){
  if(!data||!text(data.title,5,100)||!text(data.city,1,60)||!text(data.seller,1,60)||!text(data.description,10,2000)||!categories.has(data.category)||!conditions.has(data.condition)||typeof data.price!=='number'||!Number.isFinite(data.price)||data.price<1||data.price>1000000||!/^9665\d{8}$/.test(data.phone)||!Array.isArray(data.images)||data.images.length<1||data.images.length>3||!data.images.every(s=>typeof s==='string'&&s.length<650000&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)))throw fail(400,'بيانات الإعلان غير صالحة. راجع السعر والصور ورقم التواصل.');
  return {title:data.title.trim(),city:data.city.trim(),seller:data.seller.trim(),description:data.description.trim(),category:data.category,condition:data.condition,price:Math.round(data.price*100)/100,phone:data.phone,images:data.images};
}
async function body(request){
  if(!request.headers['content-type']?.startsWith('application/json'))throw fail(415,'الطلب يجب أن يكون JSON.');
  let size=0,chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>maxBody)throw fail(413,'حجم الصور أكبر من الحد المسموح.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'بيانات الطلب غير صالحة.');}
}
function transaction(work){const result=queue.then(work);queue=result.catch(()=>{});return result;}
async function save(next){
  await fs.mkdir(dataDir,{recursive:true});
  const temp=dataFile+'.tmp';await fs.writeFile(temp,JSON.stringify(next),{mode:0o600});await fs.rename(temp,dataFile);listings=next;
}
function send(response,status,data){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data));}
async function handle(request,response){
  response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/api/marketplace'||url.pathname.startsWith('/api/marketplace/')){
    // Reject cross-origin writes while allowing reverse-proxy HTTPS origins.
    const origin=request.headers.origin;
    if(request.method!=='GET'&&origin){let originHost;try{originHost=new URL(origin).host;}catch{throw fail(403,'مصدر الطلب غير مسموح.');}if(originHost!==request.headers.host)throw fail(403,'مصدر الطلب غير مسموح.');}
    if(url.pathname==='/api/marketplace'&&request.method==='GET')return send(response,200,{listings:listings.map(publicListing)});
    if(url.pathname==='/api/marketplace'&&request.method==='POST'){
      const fields=validate(await body(request));
      const ownerToken=crypto.randomBytes(32).toString('hex');
      const listing={...fields,id:crypto.randomUUID(),createdAt:Date.now(),status:'active',ownerHash:hash(ownerToken)};
      await transaction(async()=>{if(listings.length>=1000)throw fail(409,'السوق ممتلئ حاليًا. تواصل مع إدارة الموقع.');await save([listing,...listings]);});
      return send(response,201,{listing:publicListing(listing),ownerToken});
    }
    const match=url.pathname.match(/^\/api\/marketplace\/([a-zA-Z0-9-]+)$/);
    if(match&&['PATCH','DELETE'].includes(request.method)){
      const token=request.headers.authorization?.replace(/^Bearer /,'');
      if(!token||!/^[a-f0-9]{64}$/.test(token))throw fail(403,'لا تملك صلاحية إدارة هذا الإعلان.');
      const data=request.method==='PATCH'?await body(request):null;
      if(data&&!['sold','active'].includes(data.status))throw fail(400,'حالة الإعلان غير صالحة.');
      await transaction(async()=>{
        const listing=listings.find(l=>l.id===match[1]);if(!listing)throw fail(404,'الإعلان غير موجود.');
        if(!crypto.timingSafeEqual(Buffer.from(listing.ownerHash,'hex'),Buffer.from(hash(token),'hex')))throw fail(403,'لا تملك صلاحية إدارة هذا الإعلان.');
        const next=request.method==='DELETE'?listings.filter(l=>l.id!==listing.id):listings.map(l=>l.id===listing.id?{...l,status:data.status}:l);await save(next);
      });
      return send(response,200,{ok:true});
    }
    throw fail(404,'المسار غير موجود.');
  }
  if(!['GET','HEAD'].includes(request.method))throw fail(405,'الطريقة غير مسموحة.');
  if(url.pathname==='/'||url.pathname==='/your%20tech.html'||url.pathname==='/your tech.html'){
    const html=await fs.readFile(path.join(root,'your tech.html'));
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return response.end(request.method==='HEAD'?undefined:html);
  }
  if(url.pathname==='/favicon.ico'){response.writeHead(204);return response.end();}
  throw fail(404,'الملف غير موجود.');
}
async function main(){
  try{const saved=JSON.parse(await fs.readFile(dataFile,'utf8'));if(!Array.isArray(saved))throw new Error('Invalid marketplace data');listings=saved;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const server=http.createServer((req,res)=>{handle(req,res).catch(error=>{if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'تعذّر حفظ العملية. حاول مرة أخرى.'});else res.end();});});
  server.requestTimeout=30000;
  server.listen(Number(process.env.PORT||4173),process.env.HOST||'127.0.0.1',()=>console.log('Your Tech marketplace is ready on port '+(process.env.PORT||4173)));
}
main().catch(error=>{console.error('Marketplace startup failed: '+error.message);process.exitCode=1;});
