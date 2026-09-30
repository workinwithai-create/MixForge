'use strict';

// Pipe Dreams Studio owns authentication. When MixForge is embedded in the Warehouse,
// accept the Warehouse's already-verified Dreamer access token instead of asking the
// artist to sign in again inside this room.
(function installPipeDreamsAuthBridge(){
  function allowedParent(origin){
    try{
      const host=new URL(origin).hostname;
      return host==='studio.workinwithai.com'
        || host==='pipe-dreams-warehouse.vercel.app'
        || (host.startsWith('pipe-dreams-warehouse-')&&host.endsWith('.vercel.app'))
        || host==='localhost'||host==='127.0.0.1';
    }catch(_){return false;}
  }

  async function applyStudioSession(accessToken,parentOrigin){
    if(!accessToken)return;
    try{
      const response=await fetch('/api/entitlement?returnTo='+encodeURIComponent(location.href),{
        method:'GET', credentials:'include',
        headers:{Accept:'application/json',Authorization:'Bearer '+accessToken}
      });
      const payload=await response.json().catch(()=>null);
      if(!response.ok||!payload)return;
      if(payload.license){try{localStorage.setItem('mixforge-license-v1',payload.license);}catch(_){}}

      const client=globalThis.MixForgeHub;
      if(client){
        const entitled=Boolean(payload.entitled);
        const product=payload.product||null;
        client.status={
          ok:true, entitled, signedIn:Boolean(payload.email||payload.userId), product,
          reason:payload.reason||(entitled?'ok':'signed-in-unpaid'), email:payload.email||null,
          userId:payload.userId||null, license:payload.license||null,
          hasMix:product==='mix'||product==='bundle', hasBundle:product==='bundle',
          loginUrl:payload.loginUrl, checkoutUrl:payload.checkoutUrl,
          pricingUrl:payload.pricingUrl, returnTo:payload.returnTo
        };
        if(client.features){
          client.features.quickMaster=entitled;
          client.features.forensicStems=entitled;
          client.features.export=entitled;
        }
        client.render?.();
      }
      parent?.postMessage({type:'PIPE_DREAMS_STUDIO_SESSION_READY',room:'MIXFORGE',entitled:Boolean(payload.entitled)},parentOrigin);
    }catch(error){console.warn('[MixForge] Pipe Dreams session bridge failed',error);}
  }

  window.addEventListener('message',event=>{
    if(event.data?.type!=='PIPE_DREAMS_STUDIO_SESSION'||!allowedParent(event.origin))return;
    void applyStudioSession(event.data.accessToken,event.origin);
  });
})();
