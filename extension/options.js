const $ = (id) => document.getElementById(id);
const URL_PATTERN = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/;

init();

async function init() {
  const { scriptUrl = '', secret = '' } = await chrome.storage.local.get(['scriptUrl', 'secret']);
  $('scriptUrl').value = scriptUrl;
  $('secret').value = secret;
  await refreshQueue();
}

async function saveSettings() {
  const scriptUrl = $('scriptUrl').value.trim();
  const secret = $('secret').value.trim();

  if (!URL_PATTERN.test(scriptUrl)) {
    setStatus('웹앱 URL은 https://script.google.com/macros/s/…/exec 형식이어야 합니다.', 'error');
    return false;
  }
  if (!secret) {
    setStatus('비밀 키를 입력해 주세요.', 'error');
    return false;
  }

  await chrome.storage.local.set({ scriptUrl, secret });
  return true;
}

async function refreshQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  $('queueInfo').textContent = queue.length
    ? `전송하지 못한 스크랩이 ${queue.length}건 있습니다.`
    : '전송 대기 중인 스크랩이 없습니다.';
  $('flush').disabled = queue.length === 0;
}

function setStatus(message, kind = '', target = 'status') {
  $(target).textContent = message;
  $(target).className = kind;
}

$('save').addEventListener('click', async () => {
  if (await saveSettings()) setStatus('저장했습니다.', 'ok');
});

$('test').addEventListener('click', async () => {
  if (!(await saveSettings())) return;
  setStatus('연결 확인 중…');
  const res = await chrome.runtime.sendMessage({ type: 'ping' });
  if (res?.ok) setStatus(`연결 성공: "${res.sheet}" 시트`, 'ok');
  else setStatus(`연결 실패: ${res?.error || '알 수 없는 오류'}`, 'error');
});

$('flush').addEventListener('click', async () => {
  setStatus('보내는 중…', '', 'queueStatus');
  const res = await chrome.runtime.sendMessage({ type: 'flush' });
  setStatus(
    res.queued ? `${res.queued}건이 아직 남아 있습니다. 설정을 확인해 주세요.` : '모두 보냈습니다.',
    res.queued ? 'warn' : 'ok',
    'queueStatus'
  );
  await refreshQueue();
});
