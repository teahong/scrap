const MENU_ID = 'scrap-to-sheet';
const IMAGE_MENU_ID = 'scrap-image-to-sheet';
const POPUP_WIDTH = 440;
const POPUP_HEIGHT = 600;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '시트에 스크랩',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: '이미지를 시트에 스크랩',
      contexts: ['image'],
    });
  });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  flushQueue();
});

// 아이콘을 누르면 설정 페이지를 엽니다.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let pending;
  if (info.menuItemId === MENU_ID) {
    pending = { type: 'text', text: await readSelection(info, tab) };
  } else if (info.menuItemId === IMAGE_MENU_ID) {
    pending = { type: 'image', imageUrl: info.srcUrl || '', text: await readImageAlt(info, tab) };
  } else {
    return;
  }

  const id = String(Date.now());
  await chrome.storage.session.set({
    [`pending_${id}`]: {
      ...pending,
      title: tab?.title || '',
      url: info.pageUrl || tab?.url || '',
    },
  });

  const bounds = { width: POPUP_WIDTH, height: POPUP_HEIGHT };
  if (tab?.windowId != null) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      bounds.left = Math.round(win.left + (win.width - POPUP_WIDTH) / 2);
      bounds.top = Math.round(win.top + 80);
    } catch (_) {
      // 창 정보를 못 가져오면 기본 위치에 띄웁니다.
    }
  }

  chrome.windows.create({
    url: `popup.html?id=${id}`,
    type: 'popup',
    focused: true,
    ...bounds,
  });
});

// info.selectionText는 줄바꿈이 사라지므로 페이지에서 직접 선택 영역을 읽어옵니다.
async function readSelection(info, tab) {
  const fallback = (info.selectionText || '').trim();
  if (tab?.id == null || tab.id < 0) return fallback;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: () => window.getSelection().toString(),
    });
    const text = (res?.result || '').trim();
    return text || fallback;
  } catch (_) {
    // PDF 뷰어, 크롬 내부 페이지처럼 스크립트를 실행할 수 없는 곳
    return fallback;
  }
}

// 우클릭한 이미지의 alt(없으면 title) 텍스트를 설명 기본값으로 가져옵니다.
async function readImageAlt(info, tab) {
  if (tab?.id == null || tab.id < 0 || !info.srcUrl) return '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      args: [info.srcUrl],
      func: (src) => {
        const img = [...document.images].find((el) => el.currentSrc === src || el.src === src);
        return img ? (img.alt || img.title || '').trim() : '';
      },
    });
    return res?.result || '';
  } catch (_) {
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    save: () => save(msg.item),
    tags: fetchTags,
    ping: ping,
    flush: async () => {
      await flushQueue();
      return { ok: true, queued: (await getQueue()).length };
    },
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(sendResponse);
  return true; // 비동기 응답
});

// ---------- 웹앱 통신 ----------

async function callApi(body) {
  const { scriptUrl, secret } = await chrome.storage.local.get(['scriptUrl', 'secret']);
  if (!scriptUrl) throw new Error('설정에서 웹앱 URL을 먼저 입력해 주세요.');

  const res = await fetch(scriptUrl, {
    method: 'POST',
    // text/plain으로 보내야 Apps Script가 사전 요청(preflight) 없이 받습니다.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, secret }),
  });
  if (!res.ok) throw new Error(`서버 응답 오류 (HTTP ${res.status})`);

  try {
    return await res.json();
  } catch (_) {
    throw new Error("응답을 읽을 수 없습니다. 웹앱 액세스 권한이 '모든 사용자'인지 확인해 주세요.");
  }
}

async function save(item) {
  try {
    const data = await callApi({ action: 'save', item });
    if (data.ok) {
      await rememberTags(data.tags || item.tags || []);
      flushQueue();
      return { ok: true };
    }
    return { ok: false, duplicate: !!data.duplicate, error: data.error || '저장하지 못했습니다.' };
  } catch (e) {
    await enqueue(item);
    return { ok: false, queued: true, error: e.message };
  }
}

async function fetchTags() {
  try {
    const data = await callApi({ action: 'tags' });
    if (data.ok) {
      await chrome.storage.local.set({ tags: data.tags });
      return { ok: true, tags: data.tags };
    }
    return { ok: false, error: data.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ping() {
  try {
    return await callApi({ action: 'ping' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function rememberTags(newTags) {
  const { tags = [] } = await chrome.storage.local.get('tags');
  const merged = [...new Set([...newTags, ...tags])];
  await chrome.storage.local.set({ tags: merged });
}

// ---------- 실패한 스크랩 임시 보관 ----------

let flushing = false;

async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  return queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
  await updateBadge(queue.length);
}

async function enqueue(item) {
  const queue = await getQueue();
  queue.push(item);
  await setQueue(queue);
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let queue = await getQueue();
    while (queue.length) {
      let data;
      try {
        data = await callApi({ action: 'save', item: queue[0] });
      } catch (_) {
        break; // 아직 연결이 안 되면 다음 기회에 다시 보냅니다.
      }
      // 성공했거나 이미 저장된 문구면 큐에서 뺍니다.
      // 비밀 키 오류처럼 설정 문제일 때는 데이터를 지키기 위해 그대로 둡니다.
      if (!data.ok && !data.duplicate) break;
      if (data.ok) await rememberTags(data.tags || []);
      queue = queue.slice(1);
      await setQueue(queue);
    }
  } finally {
    flushing = false;
  }
}

async function updateBadge(count) {
  if (count == null) count = (await getQueue()).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setTitle({
    title: count ? `시트 스크랩 - 전송 대기 ${count}건` : '시트 스크랩 설정',
  });
}
