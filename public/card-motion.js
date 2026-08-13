(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) return;

  const root = document.documentElement;
  root.classList.add('card-motion-enabled');

  const overlay = document.createElement('div');
  overlay.id = 'card-flight-layer';
  Object.assign(overlay.style, {
    position:'fixed', inset:'0', pointerEvents:'none', zIndex:'9999', overflow:'hidden'
  });
  document.body.appendChild(overlay);

  const ease = 'cubic-bezier(.16,1,.3,1)';
  let lastPressedCard = null;
  let lastState = null;

  const center = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};
  };

  const cloneCard = source => {
    if (!source) return null;
    const c = source.cloneNode(true);
    c.removeAttribute('onclick');
    c.style.setProperty('position','fixed','important');
    c.style.setProperty('left','0','important');
    c.style.setProperty('top','0','important');
    c.style.setProperty('margin','0','important');
    c.style.setProperty('pointer-events','none','important');
    c.style.setProperty('z-index','10000','important');
    c.style.setProperty('will-change','transform,opacity,filter');
    overlay.appendChild(c);
    return c;
  };

  const fly = (source, target, opts={}) => {
    const s = center(source), t = center(target);
    if (!s || !t) return;
    const c = cloneCard(source);
    if (!c) return;
    const scale = (t.w / s.w) || 1;
    const dx = t.x - s.x, dy = t.y - s.y;
    const lift = opts.lift ?? Math.min(-80, -Math.abs(dx)*.12);
    const arc = opts.arc ?? (dx >= 0 ? -1 : 1);
    const rot0 = opts.rot ?? ((Math.random()*10)-5);
    const rot1 = rot0 + (opts.rotEnd ?? ((Math.random()*16)-8));
    const k = [
      {transform:`translate(${s.x-s.w/2}px,${s.y-s.h/2}px) rotate(${rot0}deg) scale(1)`,opacity:0.96,filter:'brightness(1.08) saturate(1.04)'},
      {transform:`translate(${s.x-s.w/2 + dx*.38}px,${s.y-s.h/2 + dy*.30 + lift}px) rotate(${rot0*-.25}deg) scale(${Math.max(scale,1.04)})`,opacity:1,filter:'brightness(1.16) saturate(1.1)'},
      {transform:`translate(${s.x-s.w/2 + dx*.78}px,${s.y-s.h/2 + dy*.78 + lift*.25}px) rotate(${rot1}deg) scale(${scale*1.025})`,opacity:1,filter:'brightness(1.05)'},
      {transform:`translate(${t.x-t.w/2}px,${t.y-t.h/2}px) rotate(${rot1}deg) scale(${scale})`,opacity:1,filter:'none'}
    ];
    const anim = c.animate(k,{duration:opts.duration??520,easing:ease,fill:'forwards',composite:'replace'});
    anim.finished.catch(()=>{}).finally(()=>setTimeout(()=>c.remove(),40));
    return anim;
  };

  const burst = (x,y,kind='light') => {
    const count = kind==='wild' ? 22 : 12;
    for(let i=0;i<count;i++){
      const p=document.createElement('i');
      const a=Math.random()*Math.PI*2;
      const d=(kind==='wild'?55:30)+Math.random()*(kind==='wild'?100:55);
      const size=2+Math.random()*5;
      Object.assign(p.style,{position:'fixed',left:`${x}px`,top:`${y}px`,width:`${size}px`,height:`${size}px`,borderRadius:'999px',background:'rgba(255,255,255,.9)',boxShadow:'0 0 12px rgba(255,255,255,.45)',transform:'translate(-50%,-50%)',opacity:'1'});
      overlay.appendChild(p);
      p.animate([{transform:'translate(-50%,-50%) scale(1)',opacity:1},{transform:`translate(${Math.cos(a)*d}px,${Math.sin(a)*d}px) scale(.25)`,opacity:0}],{duration:420+Math.random()*220,easing:'cubic-bezier(.2,.8,.2,1)'}).finished.finally(()=>p.remove());
    }
  };

  const getDiscard = () => document.querySelector('.stack .card.top') || document.querySelector('.stack .card:not(.back)');
  const getDeck = () => document.querySelector('.deck-stack .card, .draw-stack .card, .stack .back');

  document.addEventListener('pointerdown', e => {
    const card=e.target.closest('.hand .card');
    if(card && !card.classList.contains('disabled')) lastPressedCard=card;
  }, true);

  document.addEventListener('click', e => {
    const card=e.target.closest('.hand .card');
    if(card && !card.classList.contains('disabled')) {
      card.animate([{transform:'translateY(-24px) rotate(1deg) scale(1.02)'},{transform:'translateY(-31px) rotate(-1deg) scale(1.055)'},{transform:'translateY(-24px) rotate(1deg) scale(1.02)'}],{duration:240,easing:ease});
      setTimeout(()=>{ const target=getDiscard(); if(target && lastPressedCard) { const p=fly(lastPressedCard,target,{duration:560,lift:-105}); if(p) p.finished.then(()=>burst(center(target).x,center(target).y,'light')); } },20);
      lastPressedCard=null;
      return;
    }

    const b=e.target.closest('button');
    if(!b) return;
    const label=(b.textContent||'').trim().toLowerCase();
    if(label.includes('draw')) {
      const deck=getDeck();
      setTimeout(()=>{
        const cards=document.querySelectorAll('.hand .card');
        const target=cards[cards.length-1];
        if(deck && target){ fly(deck,target,{duration:500,lift:-70,rot:7}); }
      },30);
    }
  }, true);

  const watch = new MutationObserver(() => {
    const turn=document.querySelector('.turn');
    if(turn && lastState !== turn.textContent){
      turn.animate([{transform:'translateX(-50%) scale(.94)',opacity:.4},{transform:'translateX(-50%) scale(1.04)',opacity:1},{transform:'translateX(-50%) scale(1)',opacity:1}],{duration:430,easing:ease});
      lastState=turn.textContent;
    }
  });
  watch.observe(document.body,{subtree:true,childList:true,characterData:true});
})();
