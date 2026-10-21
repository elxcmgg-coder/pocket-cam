const $ = id => document.getElementById(id);
let session = null, peer = null, media = null, cursor = 0, polling = false;
let role = 'host', generation = 0, pendingIce = [], wakeLock = null;
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(endpoint, body = {}, auth = session) {
  const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.token}` } : {})
  }, body: JSON.stringify({ ...body, ...(auth ? { roomId: auth.roomId } : {}) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '连接失败，请重试。');
  return data;
}
function setRole(next) {
  if (session) return;
  role = next;
  $('hostPanel').hidden = role !== 'host'; $('phonePanel').hidden = role !== 'phone';
  $('hostMode').classList.toggle('selected', role === 'host');
  $('phoneMode').classList.toggle('selected', role === 'phone');
}
function busy(value) {
  $('hostMode').disabled = value; $('phoneMode').disabled = value;
  $('create').disabled = value; $('connect').disabled = value; $('quality').disabled = value;
  $('stop').hidden = !value;
}
async function lockScreen() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Safari may require manual screen-on. */ }
}
async function finish(notify = true) {
  const previous = session; session = null; generation++; polling = false;
  if (peer) { peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.close(); peer = null; }
  media?.getTracks().forEach(track => track.stop()); media = null;
  await wakeLock?.release().catch(() => {}); wakeLock = null;
  $('video').srcObject = null; $('placeholder').hidden = false; $('live').hidden = true;
  $('clean').disabled = true; $('mirror').disabled = true; $('pairing').hidden = true;
  document.body.classList.remove('clean-mode'); $('video').classList.remove('mirrored');
  busy(false); pendingIce = []; cursor = 0;
  if (notify && previous) await api('leave', {}, previous).catch(() => {});
}
async function failure(error) {
  await finish();
  const messages = { NotAllowedError: '摄像头权限未开启。请在 Safari 网站设置允许摄像头后重试。',
    NotFoundError: '没有找到可用摄像头。', NotReadableError: '摄像头可能被其他应用占用。',
    OverconstrainedError: '设备不支持所选相机模式，请重试。' };
  status(messages[error.name] || error.message, true);
}
function buildPeer() {
  // No external STUN/TURN: this project intentionally targets one local network.
  const current = new RTCPeerConnection({ iceServers: [] }); peer = current;
  current.onicecandidate = event => {
    if (event.candidate && session && peer === current)
      api('signal', { message: { type: 'candidate', candidate: event.candidate.toJSON() } }).catch(failure);
  };
  current.ontrack = event => {
    $('video').srcObject = event.streams[0] || new MediaStream([event.track]);
    $('video').play().catch(() => status('点击画面开始播放。'));
    $('placeholder').hidden = true; $('live').hidden = false;
    $('clean').disabled = false; $('mirror').disabled = false;
  };
  current.onconnectionstatechange = () => {
    if (peer !== current) return;
    if (current.connectionState === 'connected') status('已连接 · 视频正在局域网中传输');
    if (current.connectionState === 'disconnected') status('网络暂时中断，正在等待恢复…');
    if (current.connectionState === 'failed') failure(new Error('连接失败，请检查 Wi-Fi 隔离、防火墙及两台设备是否在同一网络，再重新配对。'));
  };
  return current;
}
async function remoteDescription(message) {
  await peer.setRemoteDescription({ type: message.type, sdp: message.sdp });
  for (const candidate of pendingIce) await peer.addIceCandidate(candidate);
  pendingIce = [];
}
async function handle(message) {
  if (message.type === 'ended') { await finish(false); status('对方已结束连接，请重新配对。'); return; }
  if (message.type === 'joined') { status('iPhone 已配对，等待开启前置摄像头…'); $('pairCode').textContent = '已配对'; return; }
  if (message.type === 'candidate') {
    if (peer?.remoteDescription) await peer.addIceCandidate(message.candidate);
    else pendingIce.push(message.candidate);
  }
  if (message.type === 'offer' && role === 'host') {
    await remoteDescription(message);
    await peer.setLocalDescription(await peer.createAnswer());
    await api('signal', { message: { type: 'answer', sdp: peer.localDescription.sdp } });
  }
  if (message.type === 'answer' && role === 'phone') await remoteDescription(message);
}
async function poll(myGeneration) {
  polling = true; let failures = 0;
  while (session && polling && generation === myGeneration) {
    try {
      const data = await api('poll', { after: cursor });
      if (generation !== myGeneration) return;
      for (const item of data.messages) {
        await handle(item.message);
        if (generation !== myGeneration) return;
        cursor = item.id;
      }
      failures = 0;
    } catch (error) {
      if (generation !== myGeneration) return;
      if (++failures >= 6) { await failure(error); return; }
      status('信令连接中断，正在重试…');
    }
    await sleep(500);
  }
}
$('hostMode').onclick = () => setRole('host');
$('phoneMode').onclick = () => setRole('phone');
$('create').onclick = async () => {
  busy(true);
  const myGeneration = generation;
  try {
    const created = await api('create', {}, null);
    if (myGeneration !== generation) { await api('leave', {}, created).catch(() => {}); return; }
    session = created; cursor = 0; buildPeer();
    $('pairCode').textContent = session.code; $('pairing').hidden = false;
    $('phoneAddress').value = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? `https://<电脑局域网 IPv4>:${location.port || '443'}/?mode=phone` : `${location.origin}/?mode=phone`;
    $('addressHint').textContent = '启动窗口会列出完整 iPhone 地址。PC 也可用该地址打开本页。';
    status('配对码已创建，等待 iPhone。一个连接只允许一部手机加入。'); poll(generation);
  } catch (error) { if (myGeneration === generation) await failure(error); }
};
$('phonePanel').onsubmit = async event => {
  event.preventDefault();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('需要可信 HTTPS。请按 README 配置证书，再用 Safari 打开电脑的局域网 HTTPS 地址。', true); return;
  }
  const code = $('code').value.replace(/\s/g, '');
  if (!/^\d{8}$/.test(code)) { status('请输入 8 位数字配对码。', true); return; }
  busy(true); status('请允许 Safari 使用前置摄像头…');
  const myGeneration = generation;
  try {
    const height = Number($('quality').value);
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { exact: 'user' }, width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 }
    } });
    if (myGeneration !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
    media = acquired;
    const joined = await api('join', { code }, null);
    if (myGeneration !== generation) { await api('leave', {}, joined).catch(() => {}); return; }
    session = joined;
    const current = buildPeer();
    for (const track of media.getTracks()) current.addTrack(track, media);
    $('video').srcObject = media; $('video').classList.add('mirrored');
    await $('video').play(); $('placeholder').hidden = true; $('live').hidden = false;
    await lockScreen();
    await current.setLocalDescription(await current.createOffer());
    await api('signal', { message: { type: 'offer', sdp: current.localDescription.sdp } });
    status('正在连接电脑…请保持本页在前台。'); poll(generation);
    for (const track of media.getVideoTracks()) track.onended = () => failure(new Error('摄像头已停止，请重新连接。'));
  } catch (error) { if (myGeneration === generation) await failure(error); }
};
$('stop').onclick = async () => { await finish(); status('连接已结束，摄像头已关闭。'); };
$('clean').onclick = () => { document.body.classList.add('clean-mode'); status('按 Esc 返回控制界面'); };
$('mirror').onclick = () => $('video').classList.toggle('mirrored');
$('video').onclick = () => $('video').play().catch(failure);
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.body.classList.remove('clean-mode'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && session && role === 'phone') lockScreen(); });
window.addEventListener('pagehide', () => {
  media?.getTracks().forEach(track => track.stop()); peer?.close();
  if (session) fetch('/api/leave', { method: 'POST', keepalive: true, headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`
  }, body: JSON.stringify({ roomId: session.roomId }) }).catch(() => {});
});
setRole(new URLSearchParams(location.search).get('mode') === 'phone' ? 'phone' : 'host');
if (!window.isSecureContext) status('当前连接不可信，请按 README 完成 HTTPS 配置。', true);
