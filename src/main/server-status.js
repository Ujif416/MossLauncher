'use strict';
const net = require('net');
const cache = new Map();
const pending = new Map();
function varInt(n) {
  const bytes = []; n >>>= 0;
  do { let b = n & 127; n >>>= 7; if (n) b |= 128; bytes.push(b); } while (n);
  return Buffer.from(bytes);
}
function readInt(b, start = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (start + i >= b.length) return null;
    const c = b[start + i]; value |= (c & 127) << (7 * i);
    if (!(c & 128)) return { value: value >>> 0, end: start + i + 1 };
  }
  throw new Error('Invalid VarInt');
}
function iconData(value) {
  if (typeof value !== 'string' || value.length > 100000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(22), 'base64');
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 64 || bytes.readUInt32BE(20) !== 64) return null;
  return value;
}
function ping({ host, port }, timeout = 4000) {
  return new Promise(resolve => {
    const started = Date.now(); let buffer = Buffer.alloc(0), settled = false;
    const socket = net.createConnection({ host, port });
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      resolve({ checkedAt: Date.now(), ...result });
    };
    const timer = setTimeout(() => finish({ state: 'unknown', message: 'Сервер не ответил на запрос статуса' }), timeout);
    socket.on('error', () => finish({ state: 'unknown', message: 'Статус недоступен' }));
    socket.on('end', () => finish({ state: 'unknown', message: 'Соединение закрыто без статуса' }));
    socket.on('connect', () => {
      const hostBytes = Buffer.from(host); const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      const packet = Buffer.concat([varInt(0), varInt(767), varInt(hostBytes.length), hostBytes, portBytes, varInt(1)]);
      socket.write(Buffer.concat([varInt(packet.length), packet, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      try {
        if (buffer.length + chunk.length > 128 * 1024) throw new Error('Oversized status');
        buffer = Buffer.concat([buffer, chunk]); const length = readInt(buffer);
        if (!length) return;
        if (length.value > 128 * 1024) throw new Error('Oversized status');
        if (buffer.length < length.end + length.value) return;
        const packet = buffer.subarray(length.end, length.end + length.value);
        const id = readInt(packet), jsonSize = id && readInt(packet, id.end);
        if (!id || id.value !== 0 || !jsonSize || jsonSize.end + jsonSize.value !== packet.length) throw new Error('Invalid status packet');
        const data = JSON.parse(packet.subarray(jsonSize.end).toString('utf8'));
        const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000 ? n : null;
        finish({ state: 'online', playersOnline: count(data.players?.online), playersMax: count(data.players?.max),
          latencyMs: Date.now() - started, favicon: iconData(data.favicon), version: String(data.version?.name || '').slice(0, 100) });
      } catch { finish({ state: 'unknown', message: 'Некорректный ответ статуса' }); }
    });
  });
}
async function status(server) {
  const key = `${server.address.host}:${server.address.port}`;
  const prev = cache.get(key);
  if (prev && Date.now() - prev.checkedAt < 20000) return prev;
  if (pending.has(key)) return pending.get(key);
  const task = ping(server.address).then(result => { cache.set(key, result); return result; }).finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
module.exports = { ping, status, iconData };
