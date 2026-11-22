'use strict';
const { nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { request } = require('./net');
const { PATHS, API } = require('../shared/constants');
const { ensureDir } = require('./storage');

function validateSkin(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 1024 * 1024 || buffer.length < 24 ||
      buffer.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Выберите PNG-скин размером до 1 МБ.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== 64 || ![32,64].includes(height)) throw new Error('Скин должен иметь размер 64×64 или 64×32 пикселя.');
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty() || img.getSize().width !== width || img.getSize().height !== height) throw new Error('Повреждённый PNG-файл.');
  return img;
}
function headImage(buffer) {
  const img = validateSkin(buffer);
  const face = img.crop({x:8,y:8,width:8,height:8}).toBitmap();
  const hat = img.crop({x:40,y:8,width:8,height:8}).toBitmap();
  // Native bitmaps are premultiplied BGRA. The base face is opaque in Minecraft.
  for (let i=0;i<face.length;i+=4) {
    const alpha=hat[i+3]/255;
    for(let c=0;c<3;c++) face[i+c]=Math.min(255,Math.round(hat[i+c]+face[i+c]*(1-alpha)));
    face[i+3]=255;
  }
  return nativeImage.createFromBitmap(face,{width:8,height:8}).toDataURL();
}
function textureUrl(value) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' ||
      !/^\/texture\/[a-f0-9]+$/i.test(url.pathname) || url.username || url.password || url.port) throw new Error('Недопустимый адрес текстуры скина.');
  url.protocol='https:';
  return url.href;
}
const pending = new Map();
async function avatar(url) {
  const safe=textureUrl(url);
  if (pending.has(safe)) return pending.get(safe);
  const job=(async()=>{
    const cache=path.join(PATHS.cacheDir,'skin-heads',crypto.createHash('sha256').update(safe).digest('hex')+'.txt');
    try { const data=fs.readFileSync(cache,'utf8');if(data.startsWith('data:image/png;base64,'))return data; } catch {}
    const res=await request(safe,{timeout:15000});
    if(res.status!==200)throw new Error('Не удалось загрузить текстуру скина.');
    const data=headImage(res.body);ensureDir(path.dirname(cache));fs.writeFileSync(cache,data);return data;
  })();
  pending.set(safe,job);
  try{return await job;}finally{pending.delete(safe);}
}
async function uploadSkin(token, buffer, variant) {
  validateSkin(buffer);
  if(!['classic','slim'].includes(variant))throw new Error('Выберите модель Classic или Slim.');
  const boundary='MossSkin'+crypto.randomBytes(16).toString('hex');
  const body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${variant}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const res=await request(`${API.mcServices}/minecraft/profile/skins`,{method:'POST',timeout:30000,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length},body});
  if(res.status<200||res.status>=300){
    const message={401:'Вход Microsoft истёк. Войдите в аккаунт повторно.',403:'Minecraft отклонил смену скина. Проверьте доступ к Java Edition.',429:'Слишком частая смена скина. Подождите и повторите позже.'};
    throw new Error(message[res.status]||`Minecraft не принял скин (HTTP ${res.status}).`);
  }
  try{return JSON.parse(res.body.toString('utf8'));}catch{return null;}
}

async function publishOfflineSkin(buffer, variant, apiKey = '') {
  const image = validateSkin(buffer);
  if (!['classic','slim'].includes(variant)) throw new Error('Выберите модель Classic или Slim.');
  const png=image.toPNG();
  const boundary='MossSkin'+crypto.randomBytes(16).toString('hex');
  const body=Buffer.concat([
    Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="variant"\r\n\r\n'+variant+'\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n'),
    png,Buffer.from('\r\n--'+boundary+'--\r\n')
  ]);
  const headers={'User-Agent':'MossLauncher/1.0.3'};
  if(typeof apiKey!=='string'||apiKey.length>1024||/[\r\n]/.test(apiKey))throw new Error('Некорректный API-ключ MineSkin.');
  if(apiKey.trim())headers.Authorization='Bearer '+apiKey.trim().replace(/^Bearer /i,'');
  async function call(route,opts={}) {
    const response=await request('https://api.mineskin.org/v2/'+route,{timeout:30000,...opts,headers:{...headers,...opts.headers}});
    if(response.status===401||response.status===403)throw new Error('MineSkin требует API-ключ. Получите личный ключ на account.mineskin.org/keys и вставьте его в поле загрузки.');
    if(response.status===429)throw new Error('Лимит MineSkin. Подождите перед повтором или используйте личный API-ключ.');
    if(response.status<200||response.status>=300)throw new Error('Ошибка MineSkin (HTTP '+response.status+'). Попробуйте позже.');
    let data;try{data=JSON.parse(response.body.toString('utf8'));}catch{throw new Error('Некорректный ответ MineSkin.');}
    if(data.success===false||data.error)throw new Error('MineSkin не смог обработать скин. Проверьте PNG и API-ключ.');
    return data;
  }
  let data=await call('queue',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':body.length},body});
  const deadline=Date.now()+180000;
  while(!data.skin){
    if(data.job?.status==='failed')throw new Error('MineSkin не смог создать текстуру скина.');
    if(data.job?.status==='completed'&&data.job.result){data=await call('skins/'+encodeURIComponent(data.job.result));break;}
    if(!data.job?.id)throw new Error('MineSkin не вернул идентификатор обработки.');
    if(Date.now()>deadline)throw new Error('Очередь MineSkin занята. Подождите несколько минут перед повторной загрузкой.');
    await new Promise(resolve=>setTimeout(resolve,2000));
    data=await call('queue/'+encodeURIComponent(data.job.id));
  }
  let url=data.skin?.texture?.url?.skin;
  if(!url&&data.skin?.texture?.data?.value){
    try{url=JSON.parse(Buffer.from(data.skin.texture.data.value,'base64').toString('utf8')).textures.SKIN.url;}catch{}
  }
  if(!url)throw new Error('MineSkin не вернул текстуру скина.');
  return {url:textureUrl(url),variant,head:headImage(png),uploadedAt:Date.now()};
}
module.exports={validateSkin,headImage,textureUrl,avatar,uploadSkin,publishOfflineSkin};
