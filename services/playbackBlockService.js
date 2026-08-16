'use strict';

// =============================================================================
// playbackBlockService — CÔNG TẮC CHẶN PHÁT của Sub node.
//
// -----------------------------------------------------------------------------
// 1. Vấn đề nó giải quyết
// -----------------------------------------------------------------------------
// nginx `:9150` hỏi Node qua `auth_request` cho MỖI file. Về lý thuyết Node đã
// chặn được mọi thứ. Nhưng thực tế trước đây thì KHÔNG:
//
//   a) `AUTH_MODE=off` (mặc định) khiến `verifyPlaybackToken` trả ALLOW ngay
//      dòng đầu. Ở mức đó Sub KHÔNG CÓ CÁCH NÀO chặn ai cả — kể cả khi biết
//      chính xác cần chặn.
//   b) `AUTH_MODE=log` cũng luôn cho qua, theo đúng thiết kế.
//   c) Cơ chế thu hồi duy nhất là `globals/blacklist.js` — mảng trong RAM của
//      đúng một tiến trình. `pm2 restart` là mất sạch, và người bị chặn xem
//      tiếp được ngay.
//
// Nghĩa là "chặn ngay bây giờ" chỉ khả thi khi đã bật enforce từ trước, và cũng
// không sống qua nổi một lần restart.
//
// -----------------------------------------------------------------------------
// 2. Nguyên tắc: BLOCK LÀ TUYỆT ĐỐI, ĐỘC LẬP VỚI AUTH_MODE
// -----------------------------------------------------------------------------
// Một mục trong danh sách này chặn thật, kể cả `AUTH_MODE=off`. Lý do: hai thứ
// đó trả lời hai câu hỏi khác nhau.
//
//   AUTH_MODE  = "có bắt buộc phải có token hợp lệ không?"  (chính sách chung)
//   block list = "cấm CỤ THỂ cái này, ngay bây giờ"          (can thiệp vận hành)
//
// Trộn chúng lại là buộc phải bật enforce cho toàn hệ thống chỉ để chặn một
// phiên — tức là phải chấp nhận rủi ro chặn nhầm hàng loạt người xem hợp lệ chỉ
// vì muốn chặn đúng một người.
//
// -----------------------------------------------------------------------------
// 3. Ràng buộc hiệu năng — hàm này chạy MỖI SEGMENT
// -----------------------------------------------------------------------------
// ~1800 lần cho một phiên xem 2 tiếng, nhân số người xem đồng thời. Vì vậy:
//
//   - Trạng thái nằm HOÀN TOÀN trong RAM (Map). Đĩa chỉ được đụng tới khi
//     THAY ĐỔI danh sách, không bao giờ trong lúc kiểm tra.
//   - Có `hasBlocks()` trả về boolean. Khi danh sách rỗng (trạng thái bình
//     thường của mọi node), `authService` chỉ tốn đúng một phép kiểm tra
//     boolean — đường nóng nhanh y như trước khi có module này.
//   - Hết hạn được dọn LƯỜI (lúc tra cứu), không có timer nào chạy nền.
//
// -----------------------------------------------------------------------------
// 4. Vì sao lưu ra file mà không phải Redis
// -----------------------------------------------------------------------------
// Quyết định kiến trúc của dự án: sub node nhẹ, KHÔNG Redis, KHÔNG DB
// (`markdowns/central-node-architecture-comparison.md`). File JSON ghi atomic
// đủ cho phạm vi "một node". Đánh đổi phải nói rõ: **block chỉ có hiệu lực trên
// node ghi nó**. Muốn chặn toàn cụm thì Central phải phát lệnh tới từng node —
// và đó là việc của Central, không phải của file này.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('../storage/paths');
const log = require('../platform/log');
const errors = require('../platform/errors');

const blockLog = log.child('playbackBlock');

const TYPES = Object.freeze(['session', 'storageKey', 'ip']);

// Giá trị phải in được và không chứa ký tự có thể giả mạo một dòng log JSON.
// IPv6 có dấu hai chấm nên không dùng chung regex với storageKey được.
const VALUE_PATTERN = Object.freeze({
  session: /^[A-Za-z0-9._:-]{1,128}$/,
  storageKey: /^[a-zA-Z0-9._-]{1,128}$/,
  ip: /^[0-9a-fA-F.:]{3,45}$/,
});

// --- Trạng thái trong RAM -----------------------------------------------------

const state = {
  loaded: false,
  // Map<type, Map<value, entry>> — tra cứu O(1) theo đúng loại đang cần.
  index: new Map(TYPES.map((type) => [type, new Map()])),
  count: 0,
};

const nowMs = () => Date.now();
const isExpired = (entry) => entry.expiresAt !== null && Date.parse(entry.expiresAt) <= nowMs();

const reindex = (entries) => {
  const index = new Map(TYPES.map((type) => [type, new Map()]));
  let count = 0;
  entries.forEach((entry) => {
    if (isExpired(entry)) return;
    index.get(entry.type).set(entry.value, entry);
    count += 1;
  });
  state.index = index;
  state.count = count;
};

const allEntries = () => {
  const out = [];
  state.index.forEach((byValue) => byValue.forEach((entry) => out.push(entry)));
  return out;
};

// --- Lưu trữ ------------------------------------------------------------------

const persist = () => {
  const file = paths.blockStoreFile();
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ savedAt: new Date().toISOString(), blocks: allEntries() }, null, 2));
  fs.renameSync(temporary, file); // atomic — xem services/encodeJobService.js mục 2
};

/**
 * Nạp từ đĩa. KHÔNG BAO GIỜ throw: file chặn hỏng không được phép chặn node
 * khởi động. Nhưng phải log mức `error` — chạy tiếp với danh sách rỗng nghĩa là
 * đang cho qua những thứ lẽ ra bị chặn, và đó là điều người vận hành cần biết.
 */
const load = () => {
  state.loaded = true;
  const file = paths.blockStoreFile();
  if (!fs.existsSync(file)) {
    reindex([]);
    return { loaded: 0, corrupt: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
    reindex(blocks);
    blockLog.info('block list loaded', { file, active: state.count, stored: blocks.length });
    return { loaded: state.count, corrupt: false };
  } catch (error) {
    reindex([]);
    blockLog.error('block list is unreadable; continuing with an EMPTY list', { file, message: error.message });
    return { loaded: 0, corrupt: true };
  }
};

const ensureLoaded = () => {
  if (!state.loaded) load();
};

// --- Đường nóng ---------------------------------------------------------------

/**
 * Kiểm tra rẻ nhất có thể. `authService` gọi hàm này TRƯỚC mọi thứ khác; khi
 * không có block nào (trạng thái bình thường), chi phí đúng bằng một so sánh số.
 */
const hasBlocks = () => {
  ensureLoaded();
  return state.count > 0;
};

/**
 * Trả entry đang chặn, hoặc null.
 *
 * Dọn lười ở đây: gặp mục hết hạn thì xoá khỏi index ngay và ghi lại đĩa. Cách
 * này không cần timer nền, đổi lại lần tra cứu ĐẦU TIÊN sau khi một block hết
 * hạn sẽ tốn thêm một lần ghi file. Chấp nhận được vì block là sự kiện hiếm.
 */
const find = (type, value) => {
  if (!value) return null;
  ensureLoaded();
  const byValue = state.index.get(type);
  if (!byValue || byValue.size === 0) return null;

  const entry = byValue.get(String(value));
  if (!entry) return null;

  if (isExpired(entry)) {
    byValue.delete(String(value));
    state.count -= 1;
    try {
      persist();
    } catch (error) {
      blockLog.warn('cannot persist after expiry cleanup', { message: error.message });
    }
    return null;
  }
  return entry;
};

/**
 * Quyết định cho một request phát video.
 * Trả `{ blocked, entry }`. KHÔNG throw.
 */
const evaluate = ({ sessionID, storageKey, ip } = {}) => {
  if (!hasBlocks()) return { blocked: false, entry: null };

  const hit = find('session', sessionID) || find('storageKey', storageKey) || find('ip', ip);
  return hit ? { blocked: true, entry: hit } : { blocked: false, entry: null };
};

// --- Quản trị -----------------------------------------------------------------

const add = ({ type, value, reason, ttlSeconds, createdBy }) => {
  ensureLoaded();
  if (!TYPES.includes(type)) {
    throw errors.fail('BLOCK_TYPE_INVALID', `type phải là một trong ${TYPES.join(' | ')}`);
  }
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!VALUE_PATTERN[type].test(normalized)) {
    throw errors.fail('BLOCK_VALUE_INVALID', `value không hợp lệ cho type=${type}`);
  }

  const ttl = Number(ttlSeconds);
  const entry = {
    id: crypto.randomUUID(),
    type,
    value: normalized,
    reason: String(reason || '').slice(0, 200) || null,
    createdBy: String(createdBy || '').slice(0, 64) || null,
    createdAt: new Date().toISOString(),
    // `null` = chặn cho tới khi gỡ tay. Cố ý cho phép: thu hồi vĩnh viễn là
    // trường hợp dùng chính (nội dung bị gỡ theo yêu cầu bản quyền).
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? new Date(nowMs() + ttl * 1000).toISOString() : null,
  };

  const byValue = state.index.get(type);
  const existing = byValue.get(normalized);
  byValue.set(normalized, entry);
  if (!existing) state.count += 1;
  persist();

  blockLog.event('playback.block.added', {
    id: entry.id,
    type: entry.type,
    value: entry.value,
    expiresAt: entry.expiresAt,
    reason: entry.reason,
    replaced: Boolean(existing),
  });
  return entry;
};

const removeById = (id) => {
  ensureLoaded();
  let removed = null;
  state.index.forEach((byValue) => {
    byValue.forEach((entry, key) => {
      if (entry.id === id) {
        byValue.delete(key);
        removed = entry;
      }
    });
  });
  if (!removed) throw errors.fail('BLOCK_NOT_FOUND', `Không có block nào mang id ${id}`);
  state.count -= 1;
  persist();
  blockLog.event('playback.block.removed', { id: removed.id, type: removed.type, value: removed.value });
  return removed;
};

// Tiện cho đường legacy `/api/v1/streaming/add-streaming/:token` (gỡ chặn theo
// sessionID chứ không theo id của block).
const removeByValue = (type, value) => {
  ensureLoaded();
  const byValue = state.index.get(type);
  if (!byValue) return null;
  const entry = byValue.get(String(value));
  if (!entry) return null;
  byValue.delete(String(value));
  state.count -= 1;
  persist();
  blockLog.event('playback.block.removed', { id: entry.id, type: entry.type, value: entry.value });
  return entry;
};

const list = () => {
  ensureLoaded();
  return allEntries()
    .filter((entry) => !isExpired(entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

const clear = () => {
  ensureLoaded();
  const removed = state.count;
  reindex([]);
  persist();
  blockLog.event('playback.block.cleared', { removed });
  return removed;
};

const stats = () => {
  ensureLoaded();
  const byType = {};
  state.index.forEach((byValue, type) => {
    byType[type] = byValue.size;
  });
  return { active: state.count, byType, store: paths.blockStoreFile() };
};

module.exports = Object.freeze({
  TYPES,
  VALUE_PATTERN,
  load,
  hasBlocks,
  evaluate,
  find,
  add,
  removeById,
  removeByValue,
  list,
  clear,
  stats,
  // Chỉ dùng cho test: dựng lại trạng thái RAM mà không đụng đĩa.
  _reset: () => {
    state.loaded = false;
    reindex([]);
  },
});
