/**
 * 시트 스크랩 - Google Apps Script 웹앱
 *
 * 크롬 익스텐션이 보낸 스크랩을 '전체' 시트와 태그별 시트(#태그)에 저장합니다.
 * 설치 방법은 README.md를 참고하세요.
 */

// 익스텐션 설정 화면에 입력할 비밀 키와 반드시 같아야 합니다.
const SECRET = '여기에-비밀키를-입력하세요';

const MAIN_SHEET = '전체';
const TAG_PREFIX = '#';
const HEADERS = ['저장일시', '문구', '태그', '메모', '페이지 제목', 'URL'];
const COLUMN_WIDTHS = [140, 420, 160, 260, 220, 280];
const DATE_FORMAT = 'yyyy-mm-dd hh:mm';

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
    case 'save':
      return json(saveScrap(req.item || {}));
    default:
      return json({ ok: false, error: '알 수 없는 요청입니다.' });
  }
}

function saveScrap(item) {
  const text = String(item.text || '').trim();
  if (!text) return { ok: false, error: '문구가 비어 있습니다.' };

  const url = String(item.url || '').trim();
  const tags = normalizeTags(item.tags);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const main = getOrCreateSheet(ss, MAIN_SHEET);

    if (isDuplicate(main, text, url)) {
      return { ok: false, duplicate: true, error: '이 페이지의 같은 문구가 이미 저장되어 있습니다.' };
    }

    const savedAt = item.savedAt ? new Date(item.savedAt) : new Date();
    const row = [
      savedAt,
      safe(text),
      tags.map((t) => TAG_PREFIX + t).join(', '),
      safe(item.memo),
      safe(item.title),
      safe(url),
    ];

    prependRow(main, row);
    tags.forEach((tag) => prependRow(getOrCreateSheet(ss, TAG_PREFIX + tag), row));

    return { ok: true, tags };
  } finally {
    lock.releaseLock();
  }
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

/** 같은 URL에서 같은 문구가 이미 '전체' 시트에 있는지 확인합니다. */
function isDuplicate(sheet, text, url) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values.some((r) => String(r[1]).trim() === text && String(r[5]).trim() === url);
}

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = name === MAIN_SHEET ? ss.insertSheet(name, 0) : ss.insertSheet(name);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS])
    .setFontWeight('bold')
    .setBackground('#1f6f50')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  COLUMN_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  return sheet;
}

/** 헤더 바로 아래에 행을 넣어 최신 스크랩이 맨 위에 오게 합니다. */
function prependRow(sheet, row) {
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
}

/** =, +, -, @로 시작하는 값이 수식으로 실행되지 않게 막습니다. */
function safe(value) {
  const s = String(value == null ? '' : value).trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
