/**
 * 시트 스크랩 - Google Apps Script 웹앱
 *
 * 크롬 익스텐션이 보낸 스크랩을 저장합니다.
 * - 텍스트: '전체' 시트
 * - 이미지: '이미지' 시트
 * - 태그가 있으면 텍스트·이미지 모두 '#태그' 시트에도 저장
 * 설치 방법은 README.md를 참고하세요.
 */

// 익스텐션 설정 화면에 입력할 비밀 키와 반드시 같아야 합니다.
const SECRET = '여기에-비밀키를-입력하세요';

const MAIN_SHEET = '전체';
const IMAGE_SHEET = '이미지';
const TAG_PREFIX = '#';
const DATE_FORMAT = 'yyyy-mm-dd hh:mm';
const IMAGE_ROW_HEIGHT = 100;

const MAIN_COLUMNS = [
  ['저장일시', 140], ['문구', 420], ['태그', 160], ['메모', 260], ['페이지 제목', 220], ['URL', 280],
];
// 태그 시트는 텍스트와 이미지를 함께 담으므로 뒤에 이미지 열이 붙습니다.
const TAG_COLUMNS = MAIN_COLUMNS.concat([['유형', 70], ['이미지 URL', 240], ['미리보기', 140]]);
const IMAGE_COLUMNS = [
  ['저장일시', 140], ['미리보기', 140], ['설명', 260], ['태그', 160], ['메모', 260],
  ['페이지 제목', 220], ['페이지 URL', 280], ['이미지 URL', 280],
];

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: '잘못된 요청 형식입니다.' });
  }

  if (SECRET.startsWith('여기에') || req.secret !== SECRET) {
    return json({ ok: false, error: '비밀 키가 일치하지 않습니다.' });
  }

  switch (req.action) {
    case 'ping':
      return json({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
    case 'tags':
      return json({ ok: true, tags: listTags() });
    case 'save': {
      const item = req.item || {};
      return json(withLock(() => (item.type === 'image' ? saveImage(item) : saveText(item))));
    }
    default:
      return json({ ok: false, error: '알 수 없는 요청입니다.' });
  }
}

function saveText(item) {
  const text = String(item.text || '').trim();
  if (!text) return { ok: false, error: '문구가 비어 있습니다.' };

  const url = String(item.url || '').trim();
  const tags = normalizeTags(item.tags);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const main = getOrCreateSheet(ss, MAIN_SHEET, MAIN_COLUMNS, 0);

  // '전체' 시트에서 문구(2열)와 URL(6열)이 같은 행을 찾습니다.
  if (hasRow(main, MAIN_COLUMNS.length, (r) => String(r[1]).trim() === text && String(r[5]).trim() === url)) {
    return { ok: false, duplicate: true, error: '이 페이지의 같은 문구가 이미 저장되어 있습니다.' };
  }

  const base = [
    toDate(item.savedAt),
    safe(text),
    formatTags(tags),
    safe(item.memo),
    safe(item.title),
    safe(url),
  ];

  prependRow(main, base);
  tags.forEach((tag) => prependRow(getTagSheet(ss, tag), base.concat(['텍스트', '', ''])));
  return { ok: true, tags };
}

function saveImage(item) {
  const imageUrl = String(item.imageUrl || '').trim();
  if (!/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: 'http(s) 주소가 있는 이미지만 저장할 수 있습니다.' };
  }

  const url = String(item.url || '').trim();
  const tags = normalizeTags(item.tags);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, IMAGE_SHEET, IMAGE_COLUMNS, 1);

  // '이미지' 시트에서 페이지 URL(7열)과 이미지 URL(8열)이 같은 행을 찾습니다.
  if (hasRow(sheet, IMAGE_COLUMNS.length, (r) => String(r[6]).trim() === url && String(r[7]).trim() === imageUrl)) {
    return { ok: false, duplicate: true, error: '이 페이지의 같은 이미지가 이미 저장되어 있습니다.' };
  }

  const savedAt = toDate(item.savedAt);
  const preview = imageFormula(imageUrl);
  const desc = safe(item.text);
  const memo = safe(item.memo);
  const title = safe(item.title);

  prependRow(sheet, [savedAt, preview, desc, formatTags(tags), memo, title, safe(url), safe(imageUrl)], IMAGE_ROW_HEIGHT);
  tags.forEach((tag) =>
    prependRow(
      getTagSheet(ss, tag),
      [savedAt, desc, formatTags(tags), memo, title, safe(url), '이미지', safe(imageUrl), preview],
      IMAGE_ROW_HEIGHT
    )
  );
  return { ok: true, tags };
}

/** '#'으로 시작하는 시트 이름을 태그 목록으로 돌려줍니다. */
function listTags() {
  return SpreadsheetApp.getActiveSpreadsheet()
    .getSheets()
    .map((s) => s.getName())
    .filter((name) => name.startsWith(TAG_PREFIX))
    .map((name) => name.slice(TAG_PREFIX.length));
}

/** 배열이나 쉼표로 구분된 문자열을 시트 이름으로 쓸 수 있는 태그 목록으로 정리합니다. */
function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const seen = new Set();
  return list
    .map((t) => String(t).trim().replace(/^#+/, '').replace(/[\[\]*?\/\\:]/g, '').trim().slice(0, 90))
    .filter((t) => t && !seen.has(t) && seen.add(t));
}

function formatTags(tags) {
  return tags.map((t) => TAG_PREFIX + t).join(', ');
}

function hasRow(sheet, width, match) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet.getRange(2, 1, lastRow - 1, width).getValues().some(match);
}

function getTagSheet(ss, tag) {
  return getOrCreateSheet(ss, TAG_PREFIX + tag, TAG_COLUMNS);
}

/** 시트가 없으면 만들고, 예전에 만든 시트라 열이 모자라면 제목 열을 덧붙입니다. */
function getOrCreateSheet(ss, name, columns, index) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = index == null ? ss.insertSheet(name) : ss.insertSheet(name, Math.min(index, ss.getNumSheets()));
    sheet.setFrozenRows(1);
  }

  const have = sheet.getLastColumn();
  if (have < columns.length) {
    const missing = columns.slice(have);
    sheet.getRange(1, have + 1, 1, missing.length)
      .setValues([missing.map((c) => c[0])])
      .setFontWeight('bold')
      .setBackground('#1f6f50')
      .setFontColor('#ffffff');
    missing.forEach((c, i) => sheet.setColumnWidth(have + 1 + i, c[1]));
  }
  return sheet;
}

/** 헤더 바로 아래에 행을 넣어 최신 스크랩이 맨 위에 오게 합니다. */
function prependRow(sheet, row, height) {
  sheet.insertRowsAfter(1, 1);
  sheet.getRange(2, 1, 1, row.length)
    .setValues([row])
    // 헤더 아래에 끼운 행은 헤더 서식을 물려받으므로 초기화합니다.
    .setFontWeight('normal')
    .setBackground(null)
    .setFontColor('#000000')
    .setVerticalAlignment('top')
    .setWrap(true);
  sheet.getRange(2, 1).setNumberFormat(DATE_FORMAT);
  // 텍스트 행은 줄바꿈에 맞춰 높이가 저절로 늘어나도록 그대로 둡니다.
  if (height) sheet.setRowHeight(2, height);
}

/** 셀 안에 썸네일을 보여주는 수식. 따옴표는 수식이 깨지지 않게 두 번 씁니다. */
function imageFormula(imageUrl) {
  return '=IMAGE("' + imageUrl.replace(/"/g, '""') + '")';
}

function toDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d) ? new Date() : d;
}

/** =, +, -, @로 시작하는 값이 수식으로 실행되지 않게 막습니다. */
function safe(value) {
  const s = String(value == null ? '' : value).trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
