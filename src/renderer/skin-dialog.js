import { el } from './ui-utils.js';
import { button, modal, selectInput } from './ui/components.js';
import { appState } from './app-state.js';

export function skinDialog(account) {
  const offline = account.type === 'offline';
  let draft=null, busy=false, closed=false;
  const preview=el('div',{className:'skin-preview'},el('p',{className:'muted'},'PNG 64×64 или 64×32, до 1 МБ'));
  const status=el('p',{className:'muted','aria-live':'polite'});
  const apiKey=el('input',{className:'input',type:'password',autocomplete:'off',placeholder:'Личный API-ключ MineSkin (если требуется)'});
  const model=selectInput('classic',[{value:'classic',label:'Classic — руки 4 пикселя'},{value:'slim',label:'Slim — руки 3 пикселя'}]);
  const pick=button('Выбрать PNG',{variant:'secondary',onClick:async()=>{
    if(busy)return;
    try{
      const result=await window.moss.accounts.pickSkin(account.uuid);
      if(!result||closed)return;
      draft=result;
      preview.replaceChildren(el('img',{src:result.preview,className:'skin-preview__head',alt:'Голова скина'}),el('img',{src:result.texture,className:'skin-preview__texture',alt:'Текстура выбранного скина'}),el('p',{},result.name));
      upload.disabled=false;status.textContent='';
    }catch(e){status.textContent=e.message;}
  }});
  const upload=button(offline ? 'Загрузить на MineSkin' : 'Применить к аккаунту',{variant:'primary',disabled:true,onClick:async()=>{
    if(!draft||busy)return;
    busy=true;pick.disabled=true;upload.disabled=true;model.disabled=true;status.textContent=offline?'Публикуем PNG на MineSkin…':'Отправляем скин в Minecraft…';
    try{
      const result=await window.moss.accounts.uploadSkin({uuid:account.uuid,id:draft.id,variant:model.value,apiKey:offline?apiKey.value:undefined});
      appState.update({accounts:result.accounts});
      appState.toast(result.warning||(offline?'Скин загружен. Примените команду в чате сервера.':'Скин применён к официальному аккаунту. Перезайдите в игру, чтобы обновить его.'),result.warning?'info':'success');
      dialog.close();
      if (result.serverCommand) skinServerDialog(result.accounts.find(a=>a.uuid===account.uuid));
    }catch(e){status.textContent=e.message;upload.disabled=false;}
    finally{busy=false;pick.disabled=false;model.disabled=false;}
  }});
  const body=el('div',{className:'col'},preview,pick,el('label',{},'Модель скина',model),
    offline ? el('label',{},'MineSkin API-ключ — не сохраняется',apiKey) : null,
    offline ? button('Получить ключ MineSkin',{variant:'ghost',onClick:()=>window.moss.system.openExternal('https://account.mineskin.org/keys')}) : null,
    el('p',{className:'muted'},offline?'PNG будет отправлен на MineSkin и станет доступен по публичной ссылке. Microsoft-аккаунт не требуется.':`Скин изменится в официальном профиле ${account.username} и будет доступен в Minecraft Java Edition.`),
    el('p',{className:'muted'},offline?'После загрузки скопируйте команду и выполните её на сервере со SkinsRestorer. Без применения команды, в одиночной игре и на серверах без поддержки скинов этот скин не появится.':'SkinsRestorer может переопределять скин на сервере. После загрузки используйте кнопку «SkinsRestorer» у аккаунта.'),status);
  const dialog=modal({title:'Загрузить скин',subtitle:account.username,body,footer:upload,onClose:()=>{closed=true;}});
  document.body.append(dialog);
}

export function skinServerDialog(account) {
  const skin=account.skins?.find(s=>s.state==='ACTIVE');
  let command=`/skin ${account.username}`;
  try {
    const url=new URL(skin?.url||account.avatar);
    if(url.hostname==='textures.minecraft.net'&&/^\/texture\/[a-f0-9]+$/i.test(url.pathname))command=`/skin url "https://textures.minecraft.net${url.pathname}" ${skin?.variant?.toLowerCase()==='slim'?'slim':'classic'}`;
  }catch{}
  if (account.type === 'offline') {
    const saved=account.offlineSkin;
    if (!saved || !/^https:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]+$/i.test(saved.url)) {
      appState.toast('Сначала загрузите PNG-скин для этого аккаунта.', 'info');
      return;
    }
    command=`/skin url "${saved.url}" ${saved.variant==='slim'?'slim':'classic'}`;
  }
  const field=el('input',{className:'input',value:command,readonly:true,'aria-label':'Команда SkinsRestorer',onClick:e=>e.target.select()});
  const status=el('p',{className:'muted','aria-live':'polite'});
  const copy=button('Скопировать команду',{variant:'primary',onClick:async()=>{try{await navigator.clipboard.writeText(command);status.textContent='Скопировано. Вставьте команду в чат сервера.';}catch{field.select();status.textContent='Нажмите Ctrl+C, чтобы скопировать команду.';}}});
  document.body.append(modal({title:'Скин на сервере SkinsRestorer',body:el('div',{className:'col'},
    el('p',{},'Вставьте эту команду в чат сервера:'),field,
    el('p',{className:'muted'},'Сервер должен разрешать смену скина и команды /skin. Команда с URL требует разрешения skinsrestorer.command.set.url. Настройки и кэш сервера могут задерживать обновление; при отказе обратитесь к администратору.'),status),footer:copy}));
}
