const $ = (id) => document.getElementById(id);
const pendingKey = `pending_${new URLSearchParams(location.search).get('id')}`;

let pending = null;
let knownTags = [];

init();

async function init() {
  pending = (await chrome.storage.session.get(pendingKey))[pendingKey];
  if (!pending) {
    setStatus('스크랩할 문구를 찾지 못했습니다. 다시 시도해 주세요.', 'error');
    $('save').disabled = true;
    return;
  }

  $('text').value = pending.text;
  $('pageTitle').textContent = pending.title || pending.url;
  $('pageTitle').href = pending.url;
  $('pageTitle').title = pending.url;

  // 저장해 둔 태그로 먼저 보여주고, 시트의 최신 목록으로 갱신합니다.
  const { tags = [] } = await chrome.storage.local.get('tags');
  knownTags = tags;
  renderSuggestions();
  chrome.runtime.sendMessage({ type: 'tags' }).then((res) => {
    if (res?.ok) {
      knownTags = res.tags;
      renderSuggestions();
    }
  });

  $('tags').focus();
}

function parseTags(value) {
  const tags = value
    .split(',')
    .map((t) => t.trim().replace(/^#+/, '').trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

// 지금 입력 중인 단어(마지막 쉼표 뒤)로 기존 태그를 걸러 보여줍니다.
function renderSuggestions() {
  const value = $('tags').value;
  const typing = value.split(',').pop().trim().replace(/^#+/, '').toLowerCase();
  const chosen = new Set(parseTags(value));
  const matches = knownTags
    .filter((t) => !chosen.has(t) && t.toLowerCase().includes(typing))
    .slice(0, 12);

  const box = $('suggestions');
  box.replaceChildren(
    ...matches.map((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = `#${tag}`;
      chip.addEventListener('click', () => addTag(tag));
      return chip;
    })
  );
}

function addTag(tag) {
  const parts = $('tags').value.split(',');
  parts[parts.length - 1] = ` ${tag}`;
  $('tags').value = parts.join(',').replace(/^\s+/, '') + ', ';
  $('tags').focus();
  renderSuggestions();
}

async function save() {
  const text = $('text').value.trim();
  if (!text) {
    setStatus('문구를 입력해 주세요.', 'error');
    return;
  }

  $('save').disabled = true;
  setStatus('저장 중…');

  const item = {
    text,
    tags: parseTags($('tags').value),
    memo: $('memo').value.trim(),
    title: pending.title,
    url: pending.url,
    savedAt: new Date().toISOString(),
  };

  const res = await chrome.runtime.sendMessage({ type: 'save', item });

  if (res?.ok) {
    setStatus('저장했습니다.', 'ok');
    await closeSoon(600);
  } else if (res?.queued) {
    setStatus(`전송 실패: ${res.error}\n임시 보관했다가 다음 저장 때 다시 보냅니다.`, 'warn');
    await closeSoon(3500);
  } else {
    setStatus(res?.error || '저장하지 못했습니다.', 'error');
    $('save').disabled = false;
  }
}

async function closeSoon(ms) {
  await chrome.storage.session.remove(pendingKey);
  setTimeout(() => window.close(), ms);
}

function setStatus(message, kind = '') {
  $('status').textContent = message;
  $('status').className = kind;
}

$('tags').addEventListener('input', renderSuggestions);
$('save').addEventListener('click', save);
$('cancel').addEventListener('click', async () => {
  await chrome.storage.session.remove(pendingKey);
  window.close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('save').disabled) {
    e.preventDefault();
    save();
  } else if (e.key === 'Escape') {
    $('cancel').click();
  }
});
