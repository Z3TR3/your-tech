/* Supabase REST adapter for GitHub Pages. No Node server is required. */
(() => {
  'use strict';
  const config=window.YOUR_TECH_MARKET||{};
  const url=String(config.supabaseUrl||'').replace(/\/$/,'');
  const apiKey=String(config.publishableKey||'');
  const configured=Boolean(url||apiKey);
  const validConfig=/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)&&/^sb_publishable_[A-Za-z0-9_-]+$/.test(apiKey);
  const storageKey='yourtech.supabase.session.'+url;
  let session=null,sessionTask=null;
  try{const stored=JSON.parse(localStorage.getItem(storageKey));if(stored?.access_token&&stored?.refresh_token&&stored?.user?.id)session=stored;}catch{}
  function saveSession(data){
    if(!data?.access_token||!data?.refresh_token||!data?.user?.id)throw new Error('تعذّر إنشاء جلسة البائع.');
    session={access_token:data.access_token,refresh_token:data.refresh_token,user:data.user,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};
    try{localStorage.setItem(storageKey,JSON.stringify(session));}catch{throw new Error('فعّل التخزين في المتصفح لحفظ إمكانية إدارة إعلانك.');}
    return session;
  }
  async function request(endpoint,options={},token){
    if(!validConfig)throw new Error('إعداد الاتصال بالسوق لم يكتمل.');
    let response;
    try{response=await fetch(url+endpoint,{...options,signal:AbortSignal.timeout(15000),headers:{apikey:apiKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});}catch{throw new Error('تعذّر الاتصال بالسوق. تحقق من الإنترنت وحاول مرة أخرى.');}
    const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{throw new Error('استجابة السوق غير صالحة.');}
    if(!response.ok){
      const code=data?.code||data?.error_code;
      const error=new Error(response.status===429?'وصلت إلى حد المحاولات. انتظر قليلًا ثم حاول مجددًا.':code==='anonymous_provider_disabled'?'إضافة الإعلانات غير مفعّلة حاليًا.':response.status===401||response.status===403?'تعذّر التحقق من صلاحية إدارة الإعلان.':code==='P0001'?'يمكنك الاحتفاظ بـ20 إعلانًا كحد أقصى. احذف إعلانًا قديمًا.':'تعذّر تنفيذ العملية في السوق. حاول مرة أخرى.');
      error.status=response.status;throw error;
    }
    return data;
  }
  async function authenticate(create){
    if(session&&session.expires_at>Date.now()/1000+60)return session;
    if(sessionTask)return sessionTask;
    sessionTask=(async()=>{
      if(session){
        try{return saveSession(await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})}));}
        catch(error){if(error.status!==400&&error.status!==401)throw error;session=null;try{localStorage.removeItem(storageKey);}catch{}throw new Error('انتهت جلسة البائع؛ أعد فتح الصفحة. إعلانات الجلسة السابقة تحتاج استعادة من إدارة الموقع.');}
      }
      if(!create)return null;
      // Check persistence before creating a seller account.
      try{localStorage.setItem(storageKey+'.check','1');localStorage.removeItem(storageKey+'.check');}catch{throw new Error('فعّل التخزين في المتصفح لإضافة إعلان.');}
      return saveSession(await request('/auth/v1/signup',{method:'POST',body:JSON.stringify({data:{}})}));
    })();
    try{return await sessionTask;}finally{sessionTask=null;}
  }
  function listing(row){return {...row,ownerId:row.owner_id,createdAt:Date.parse(row.created_at)};}
  const fields='id,owner_id,title,category,condition,price,city,seller,phone,description,images,created_at,status';
  async function api(path='',options={}){
    const method=options.method||'GET';
    if(method==='GET'){
      // Viewing the market does not create an anonymous account.
      await authenticate(false);
      const data=await request('/rest/v1/market_listings?select='+fields+'&order=created_at.desc&limit=200',{},session?.access_token);
      if(!Array.isArray(data))throw new Error('استجابة السوق غير صالحة.');return {listings:data.map(listing)};
    }
    const auth=await authenticate(method==='POST');if(!auth)throw new Error('إدارة الإعلان متاحة من المتصفح الذي أنشأه فيه.');
    const body=options.body?JSON.parse(options.body):null;
    if(method==='POST'){
      const payload={title:body.title,category:body.category,condition:body.condition,price:body.price,city:body.city,seller:body.seller,phone:body.phone,description:body.description,images:body.images};
      const result=await request('/rest/v1/market_listings?select='+fields,{method:'POST',body:JSON.stringify(payload),headers:{Prefer:'return=representation'}},auth.access_token);
      if(!result?.[0])throw new Error('لم يُحفظ الإعلان.');return {listing:listing(result[0]),ownerToken:'supabase'};
    }
    const id=decodeURIComponent(path.slice(1));if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('الإعلان غير صالح.');
    if(!['PATCH','DELETE'].includes(method))throw new Error('العملية غير صالحة.');
    const endpoint='/rest/v1/market_listings?id=eq.'+encodeURIComponent(id)+'&owner_id=eq.'+encodeURIComponent(auth.user.id)+'&select='+(method==='PATCH'?fields:'id');
    const payload={};
    if(method==='PATCH'){
      for(const name of ['title','category','condition','price','city','seller','phone','description','images','status'])if(body&&Object.prototype.hasOwnProperty.call(body,name))payload[name]=body[name];
      if(!Object.keys(payload).length)throw new Error('لا توجد تعديلات لحفظها.');
    }
    const result=await request(endpoint,{method,headers:{Prefer:'return=representation'},...(method==='PATCH'?{body:JSON.stringify(payload)}:{})},auth.access_token);
    if(!result?.length)throw new Error('الإعلان غير موجود أو لا تملك صلاحية إدارته.');return method==='PATCH'?{ok:true,listing:listing(result[0])}:{ok:true};
  }
  window.YourTechCloud={configured,get userId(){return session?.user?.id||null;},api};
})();
