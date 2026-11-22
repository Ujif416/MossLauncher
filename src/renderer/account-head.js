import { el, asset } from './ui-utils.js';
const heads = new Map();
export function accountHead(account) {
  const fallback = asset('placeholders', 'avatar.png');
  const img = el('img', {src:fallback,alt: account?.username ? `Голова ${account.username}` : '',className:'skin-head'});
  img.addEventListener('error',()=>{if(img.getAttribute('src')!==fallback)img.src=fallback;});
  if(account?.type === 'offline') {
    if(account.offlineSkin?.head?.startsWith('data:image/png;base64,'))img.src=account.offlineSkin.head;
    return img;
  }
  if(account?.type !== 'microsoft')return img;
  const key=account.uuid+':'+(account.skins?.find(s=>s.state==='ACTIVE')?.url||account.avatar||'');
  if(!heads.has(key)) {
    const job=window.moss.accounts.avatar(account.uuid).catch(()=>null);
    heads.set(key,job);
    job.then(data=>{if(!data)heads.delete(key);});
  }
  heads.get(key).then(data=>{if(data)img.src=data;});
  return img;
}
