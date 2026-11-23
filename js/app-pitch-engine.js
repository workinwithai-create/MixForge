'use strict';

// Pitch engine: key detection, pitch shift and snap-to-key.
// Taken unchanged from MixDoctor's engine.js (workinwithai-create/mixdoctor), where it is checked against
// tones with known answers. It is wrapped in one object here because MixForge already has its own global
// fft(); nothing inside touches the page. tests/pitch-engine-smoke.mjs repeats MixDoctor's checks.
const MFPitch = (() => {
  // ---- FFT (radix-2, in place) ----
  function fft(re,im){
    const n=re.length;
    for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
    for(let len=2;len<=n;len<<=1){
      const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang),h=len>>1;
      for(let i=0;i<n;i+=len){let cr=1,ci=0;
        for(let k=0;k<h;k++){const a=i+k,b=a+h,vr=re[b]*cr-im[b]*ci,vi=re[b]*ci+im[b]*cr;re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;const t=cr;cr=cr*wr-ci*wi;ci=t*wi+ci*wr;}}}
  }

  // ---- Key detection (Krumhansl profiles) ----
  const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const KMAJ=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const KMIN=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const SCALES={major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],dorian:[0,2,3,5,7,9,10],mixolydian:[0,2,4,5,7,9,10],major_pent:[0,2,4,7,9],minor_pent:[0,3,5,7,10]};
  function chromaOf(buf){
    const sr=buf.sampleRate,L=buf.getChannelData(0),R=buf.numberOfChannels>1?buf.getChannelData(1):L,len=L.length;
    let N=16384;while(N>1024&&N>len)N>>=1; // long windows so low notes land on the right pitch
    const chroma=new Float64Array(12),re=new Float64Array(N),im=new Float64Array(N),win=new Float64Array(N);
    for(let i=0;i<N;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/N);
    const span=Math.max(0,len-N),wins=span?Math.min(80,Math.floor(span/(N/2))+1):1;
    for(let w=0;w<wins;w++){
      const off=wins>1?Math.floor(w*span/(wins-1)):0;
      for(let i=0;i<N;i++){const j=off+i;re[i]=j<len?(L[j]+R[j])*0.5*win[i]:0;im[i]=0;}
      fft(re,im);
      for(let k=2;k<N/2;k++){const f=k*sr/N;if(f<65||f>2000)continue;const m=Math.sqrt(re[k]*re[k]+im[k]*im[k]);if(m<1e-6)continue;
        const midi=69+12*Math.log2(f/440),pc=((Math.round(midi)%12)+12)%12;chroma[pc]+=m;}
    }
    const s=chroma.reduce((a,b)=>a+b,0)+1e-9;return Array.from(chroma).map(v=>v/s);
  }
  function detectKeyJS(buf){
    const c=chromaOf(buf);let best=-2,bk='C',bs='minor';
    for(let s=0;s<12;s++)for(const[name,prof]of[['major',KMAJ],['minor',KMIN]]){
      const p=prof.map((_,i)=>prof[(i-s+12)%12]);
      const mc=c.reduce((a,b)=>a+b,0)/12,mp=p.reduce((a,b)=>a+b,0)/12;
      let num=0,dn1=0,dn2=0;for(let i=0;i<12;i++){num+=(c[i]-mc)*(p[i]-mp);dn1+=(c[i]-mc)**2;dn2+=(p[i]-mp)**2;}
      const r=num/(Math.sqrt(dn1*dn2)+1e-9);if(r>best){best=r;bk=NAMES[s];bs=name;}
    }
    return {key:bk,scale:bs,confidence:best,chroma:c};
  }

  // ---- Pitch tools (on this device) ----
  // A grain of the song is re-read faster or slower, which changes its pitch, and each new grain is placed where its
  // waveform lines up with the grain before it (WSOLA). That keeps a held note one clean note instead of a flutter.
  // "Keep natural tone" measures the broad shape of the spectrum (where the voice's resonances sit) before and after
  // the shift and puts the original shape back, so a shifted voice does not turn chipmunk.
  function makeFFT(N){ // fixed-size FFT with tables, for the per-grain work
    let bits=0;while((1<<bits)<N)bits++;
    const rev=new Int32Array(N),cs=new Float64Array(N>>1),sn=new Float64Array(N>>1);
    for(let i=0;i<N;i++){let r=0;for(let q=0;q<bits;q++)if(i&(1<<q))r|=1<<(bits-1-q);rev[i]=r;}
    for(let i=0;i<N>>1;i++){cs[i]=Math.cos(2*Math.PI*i/N);sn[i]=Math.sin(2*Math.PI*i/N);}
    return function(re,im,inverse){
      for(let i=0;i<N;i++){const j=rev[i];if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
      for(let len=2;len<=N;len<<=1){const h=len>>1,step=N/len;
        for(let i=0;i<N;i+=len)for(let k=0,t=0;k<h;k++,t+=step){
          const wr=cs[t],wi=inverse?sn[t]:-sn[t],a=i+k,b=a+h,vr=re[b]*wr-im[b]*wi,vi=re[b]*wi+im[b]*wr;
          re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;}}
      if(inverse)for(let i=0;i<N;i++){re[i]/=N;im[i]/=N;}
    };
  }
  // chs: array of Float32Array (one per channel). ratioAt(sample) gives the pitch ratio wanted around that sample.
  // progress (optional) is awaited now and then with a 0..1 figure, so a page can show progress and stay responsive.
  async function wsolaShift(chs,sr,ratioAt,preserve,progress){
    const nc=chs.length,n=chs[0].length,G=sr>60000?4096:2048,H=G>>1,half=G>>1,DS=4,K=G>>1;
    const outs=[],g=[];for(let c=0;c<nc;c++){outs.push(new Float32Array(n));g.push(new Float32Array(G));}
    let mono=chs[0];if(nc>1){mono=new Float32Array(n);for(let i=0;i<n;i++)mono[i]=(chs[0][i]+chs[1][i])*0.5;}
    const nd=Math.floor(n/DS),md=new Float32Array(nd);for(let i=0;i<nd;i++){const o=i*DS;md[i]=(mono[o]+mono[o+1]+mono[o+2]+mono[o+3])*0.25;}
    const sw=new Float32Array(G);for(let i=0;i<G;i++)sw[i]=Math.sin(Math.PI*(i+0.5)/G); // used twice per grain; squares add up to 1 at half overlap
    const sd=Math.ceil(sr/140/DS),ld=(G>>1)/DS,LC=G>>1; // search half the longest pitch period either side; compare half a grain
    const fftG=makeFFT(G),re=new Float64Array(G),im=new Float64Array(G),re2=new Float64Array(G),im2=new Float64Array(G);
    const Px=new Float64Array(K+1),Pg=new Float64Array(K+1),acc=new Float64Array(K+2),gain=new Float32Array(K+1);
    function smooth(P,B){for(let pass=0;pass<2;pass++){acc[0]=0;for(let k=0;k<=K;k++)acc[k+1]=acc[k]+P[k];for(let k=0;k<=K;k++){const lo=k-B<0?0:k-B,hi=k+B>K?K:k+B;P[k]=(acc[hi+1]-acc[lo])/(hi-lo+1);}}}
    let prevA=0,prevR=1,have=false,count=0;
    for(let o=-half;o<n;o+=H){
      if(progress&&(++count&127)===0)await progress(Math.max(0,o)/n);
      let r=ratioAt(o+half);if(!(r>0.25&&r<4))r=1;
      let a=Math.round(o+half*(1-r)); // the same moment of the song stays in the middle of the grain
      if(have&&!(r===1&&prevR===1)){
        const t=Math.round(prevA+H*prevR),td=Math.round(t/DS),ad=Math.round(a/DS); // t = where the last grain would carry on
        if(td>=0&&td+ld<nd&&ad-sd>=0&&ad+sd+ld<nd){
          let e2=0;for(let j=0;j<ld;j++)e2+=md[td+j]*md[td+j];
          if(e2>1e-8){
            let best=-2,bs=0;
            for(let m=0;m<=2*sd;m++){const s=(m&1)?(m+1)>>1:-(m>>1);let dot=0,e1=0;const b=ad+s;
              for(let j=0;j<ld;j++){const v=md[b+j];dot+=v*md[td+j];e1+=v*v;}
              const c=dot/Math.sqrt(e1*e2+1e-20);if(c>best+1e-4){best=c;bs=s;}}
            a+=bs*DS;
            if(t>=0&&t+LC<n&&a-DS>=0&&a+DS+LC<n){ // fine-tune at full rate
              let fb=-Infinity,fs=0;
              for(let s=-DS;s<=DS;s++){let dot=0;for(let j=0;j<LC;j+=2)dot+=mono[a+s+j]*mono[t+j];if(dot>fb){fb=dot;fs=s;}}
              a+=fs;
            }
          }
        }
      }
      for(let c=0;c<nc;c++){const x=chs[c],gc=g[c];
        for(let i=0;i<G;i++){const p=a+i*r,i0=Math.floor(p);if(i0<0||i0+1>=n){gc[i]=0;continue;}const f=p-i0;gc[i]=(x[i0]+(x[i0+1]-x[i0])*f)*sw[i];}}
      if(preserve>0.01&&Math.abs(Math.log2(r))>0.11&&o>=0&&o+G<=n){ // only worth it from about 1.5 semitones
        for(let i=0;i<G;i++){re[i]=mono[o+i]*sw[i];im[i]=0;}fftG(re,im,false);for(let k=0;k<=K;k++)Px[k]=re[k]*re[k]+im[k]*im[k];
        for(let i=0;i<G;i++){re[i]=nc>1?(g[0][i]+g[1][i])*0.5:g[0][i];im[i]=0;}fftG(re,im,false);for(let k=0;k<=K;k++)Pg[k]=re[k]*re[k]+im[k]*im[k];
        // blur just enough to hide the individual harmonics (their spacing follows the note being sung), no more
        const f0=f0At(mono,o+half,sr),B=Math.max(2,Math.round((f0?Math.min(600,Math.max(110,0.6*f0*(r>1?r:1))):250)*G/sr));
        smooth(Px,B);smooth(Pg,B);
        let any=false;for(let k=0;k<=K;k++){let q=Math.pow((Px[k]+1e-16)/(Pg[k]+1e-16),preserve*0.5);if(q>4)q=4;else if(q<0.063)q=0.063;gain[k]=q;if(q!==1)any=true;}
        if(any)for(let c=0;c<nc;c++){const gc=g[c];let eg=0,ey=0;
          if(nc>1){for(let i=0;i<G;i++){re2[i]=gc[i];im2[i]=0;}fftG(re2,im2,false);}else{re2.set(re);im2.set(im);}
          for(let k=0;k<=K;k++){const q=gain[k];re2[k]*=q;im2[k]*=q;if(k>0&&k<K){re2[G-k]*=q;im2[G-k]*=q;}}
          fftG(re2,im2,true);
          for(let i=0;i<G;i++){eg+=gc[i]*gc[i];ey+=re2[i]*re2[i];}
          const q=Math.sqrt(eg/(ey+1e-20)); // same loudness as before the tone correction
          if(q>0.05&&q<20)for(let i=0;i<G;i++)gc[i]=re2[i]*q;
        }
      }
      for(let c=0;c<nc;c++){const oc=outs[c],gc=g[c];const i0=o<0?-o:0,i1=o+G>n?n-o:G;for(let i=i0;i<i1;i++)oc[o+i]+=gc[i]*sw[i];}
      prevA=a;prevR=r;have=true;
    }
    return outs;
  }
  // Pitch of a sung or played note around sample "center" (0 when there is no clear note)
  function f0At(mono,center,sr){
    const D=sr>60000?8:4,fs=sr/D,W=512,minL=Math.max(2,Math.floor(fs/800)),maxL=Math.ceil(fs/70),need=(W+maxL+2)*D;
    const s=Math.round(center-need/2);if(s<0||s+need>mono.length)return 0;
    const m=W+maxL+2,xd=new Float32Array(m);let e=0;
    for(let i=0;i<m;i++){let v=0;const o=s+i*D;for(let k=0;k<D;k++)v+=mono[o+k];xd[i]=v/D;if(i<W)e+=xd[i]*xd[i];}
    if(e/W<1e-7)return 0;
    const nsdf=new Float32Array(maxL+2);let e2=e,M=0;
    for(let L=1;L<=maxL+1;L++){e2+=xd[W+L-1]*xd[W+L-1]-xd[L-1]*xd[L-1];let num=0;for(let i=0;i<W;i++)num+=xd[i]*xd[i+L];nsdf[L]=2*num/(e+e2+1e-20);}
    let L0=1;while(L0<maxL&&nsdf[L0]>0)L0++; // past the first hump around zero lag
    for(let L=Math.max(L0,minL);L<=maxL;L++)if(nsdf[L]>M)M=nsdf[L];
    if(M<0.5)return 0;
    let pick=0;for(let L=Math.max(L0,minL);L<=maxL;L++)if(nsdf[L]>=0.9*M&&nsdf[L]>=nsdf[L-1]&&nsdf[L]>=nsdf[L+1]){pick=L;break;} // first strong peak = the real period, not a multiple
    if(!pick)return 0;
    // sharpen at full rate
    const c0=Math.round(center),Wf=Math.min(1024,Math.floor(mono.length/4)),b=c0-(Wf>>1),lf=pick*D;
    if(b<0||b+Wf+lf+D+2>mono.length){const a=nsdf[pick-1],bb=nsdf[pick],cc=nsdf[pick+1],d=a-2*bb+cc;return fs/(pick+(d?0.5*(a-cc)/d:0));}
    let bl=lf,bv=-Infinity;const cv=[];
    for(let L=lf-D;L<=lf+D;L++){let num=0,ea=0,eb=0;for(let i=0;i<Wf;i++){const p=mono[b+i],q=mono[b+i+L];num+=p*q;ea+=p*p;eb+=q*q;}const v=2*num/(ea+eb+1e-20);cv.push(v);if(v>bv){bv=v;bl=L;}}
    const i=bl-(lf-D);let fr=0;if(i>0&&i<cv.length-1){const d=cv[i-1]-2*cv[i]+cv[i+1];if(d)fr=0.5*(cv[i-1]-cv[i+1])/d;}
    return sr/(bl+fr);
  }
  // How many semitones each stretch of the vocal has to move to land on the nearest note of the scale
  function tuneCurve(mono,sr,key,scale,strength){
    const root=NAMES.indexOf(key),pcs=SCALES[scale].map(i=>(root+i)%12),hop=1024,frames=Math.ceil(mono.length/hop),raw=new Float32Array(frames),sm=new Float32Array(frames);
    for(let f=0;f<frames;f++){
      const f0=f0At(mono,f*hop+hop/2,sr);if(!f0)continue;
      const midi=69+12*Math.log2(f0/440);let near=midi,bd=99;
      for(let m=Math.floor(midi)-6;m<=Math.ceil(midi)+6;m++){if(pcs.indexOf(((m%12)+12)%12)<0)continue;const d=Math.abs(m-midi);if(d<bd){bd=d;near=m;}}
      const c=(near-midi)*strength;raw[f]=Math.abs(c)<0.03?0:c;
    }
    for(let f=0;f<frames;f++){const a=raw[Math.max(0,f-1)],b=raw[f],c=raw[Math.min(frames-1,f+1)];sm[f]=Math.max(Math.min(a,b),Math.min(Math.max(a,b),c));} // middle of three: drops one-frame glitches
    return {hop:hop,semis:sm};
  }

  return { NAMES, SCALES, fft, chromaOf, detectKeyJS, makeFFT, wsolaShift, f0At, tuneCurve };
})();

if (typeof module !== 'undefined') module.exports = { MFPitch };
