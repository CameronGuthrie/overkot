'use strict';

const fs = require('node:fs/promises');

const CHUNK_BYTES = 512 * 1024;
// The longest supported account/nonce pattern is 136 bytes in UTF-16LE.
const OVERLAP_BYTES = 160;

function scanError(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'permission-denied';
  if (['ENOENT', 'ESRCH'].includes(error?.code)) return 'process-gone';
  return 'scan-failed';
}

function readableRegions(maps) {
  return maps.split('\n').flatMap(line => {
    const match = line.match(/^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]+)\s+\S+\s+\S+\s+\S+\s*(.*)$/i);
    if (!match || match[3][0] !== 'r') return [];
    const start = Number.parseInt(match[1], 16), end = Number.parseInt(match[2], 16);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return [];
    return [{ start, end, writable: match[3].includes('w'), name: match[4] }];
  }).sort((a, b) => {
    const priority = region => region.name === '[heap]' ? 0 : region.writable ? 1 : 2;
    return priority(a) - priority(b) || a.start - b.start;
  });
}

/** Read only a discovered game's memory, with ordinary user permissions.
 * Async file reads and explicit yields keep the Electron main loop responsive.
 * Limits apply to attempted reads as well as successful reads, including when
 * mappings disappear mid-scan. A later scan rotates through larger mappings.
 */
async function scanLinuxMemory(pid, onChunk, {
  extended = false, state = {}, fsImpl = fs, now = Date.now,
  yieldControl = () => new Promise(resolve => setImmediate(resolve)),
  byteLimit = (extended ? 512 : 128) * 1024 * 1024,
  regionLimit = (extended ? 64 : 4) * 1024 * 1024,
  timeLimitMs = extended ? 10_000 : 5_000,
  chunkSize = CHUNK_BYTES,
} = {}) {
  const result = { error: '', bytesRead: 0, regionsScanned: 0, limited: false };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ...result, error: 'process-gone' };
  const started = now();
  let handle;
  let failedReads = 0;
  try {
    const maps = await fsImpl.readFile(`/proc/${pid}/maps`, 'utf8');
    handle = await fsImpl.open(`/proc/${pid}/mem`, 'r');
    const buffer = Buffer.alloc(chunkSize);
    let attempted = 0;
    const regions = readableRegions(maps);
    const keyOf = region => `${region.start}:${region.end}`;
    if (!(state.offsets instanceof Map)) state.offsets = new Map();
    const keys = new Set(regions.map(keyOf));
    for (const key of state.offsets.keys()) if (!keys.has(key)) state.offsets.delete(key);
    const first = Math.max(0, regions.findIndex(region => keyOf(region) === state.nextRegion));
    for (let index = 0; index < regions.length; index++) {
      const position = (first + index) % regions.length;
      const region = regions[position], key = keyOf(region);
      state.nextRegion = key;
      let carry = Buffer.alloc(0);
      const size = region.end - region.start;
      // Include large Wine mappings without making each scan unbounded. Adjacent
      // windows overlap so a credential split at their boundary remains visible.
      const windowStart = state.offsets.get(key) || 0;
      let offset = Math.max(0, windowStart - OVERLAP_BYTES);
      const end = Math.min(size, windowStart + regionLimit);
      const advance = () => {
        state.offsets.set(key, offset >= size ? 0 : offset);
        state.nextRegion = keyOf(regions[(position + 1) % regions.length]);
      };
      result.regionsScanned++;
      while (offset < end) {
        if (attempted >= byteLimit || now() - started >= timeLimitMs) {
          result.limited = true;
          return result;
        }
        const length = Math.min(chunkSize, end - offset, byteLimit - attempted);
        attempted += length;
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(buffer, 0, length, region.start + offset));
        } catch (error) {
          if (['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error?.code)) {
            result.error = scanError(error);
            return result;
          }
          // EIO commonly means the mapping changed after maps was read.
          failedReads++;
          offset += length;
          advance();
          carry = Buffer.alloc(0);
          await yieldControl();
          continue;
        }
        if (!bytesRead) {
          failedReads++;
          offset += length;
          advance();
          carry = Buffer.alloc(0);
          await yieldControl();
          continue;
        }
        result.bytesRead += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        const search = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        // Scan both alignments: a UTF-16 string can start at an odd address.
        const keepScanning = onChunk(search.toString('latin1')) !== false
          && onChunk(search.toString('utf16le')) !== false
          && onChunk(search.subarray(1).toString('utf16le')) !== false;
        carry = Buffer.from(search.subarray(Math.max(0, search.length - OVERLAP_BYTES)));
        offset += bytesRead;
        advance();
        await yieldControl();
        if (!keepScanning) { result.limited = true; return result; }
      }
    }
  } catch (error) {
    result.error = scanError(error);
  } finally {
    if (!result.error && failedReads && !result.bytesRead) result.error = 'scan-failed';
    if (handle) await handle.close().catch(() => {});
  }
  return result;
}

module.exports = { scanLinuxMemory, readableRegions };
