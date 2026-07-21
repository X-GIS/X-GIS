// ═══ HDF5 subset reader — superblock (v0 + v2 only) ═══
//
// Parses the superblock and returns the root object-header address + the
// offset/length word widths every later read depends on. Subset (A1):
//   • v0  — accept. Root reached via the root-group SYMBOL TABLE ENTRY.
//   • v1  — HARD ERROR (indexed-storage-K variant; not in the S-100 corpus).
//   • v2  — accept. Root object-header address stored directly.
//   • v3  — HARD ERROR: "latest-format writer; re-write with default libver".
// A non-zero user block is a HARD ERROR (A1).

import { Cursor, Hdf5Error } from './bytes'

const SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] // ‰HDF\r\n␚\n

export interface Superblock {
  version: number
  offsetSize: number
  lengthSize: number
  baseAddress: number
  /** Absolute file address of the root group's object header. */
  rootObjectHeaderAddr: number
  /** Address of the superblock (0 unless a user block precedes it — errored). */
  superblockAddr: number
}

function matchSig(c: Cursor, at: number): boolean {
  if (at + 8 > c.byteLength) return false
  for (let i = 0; i < 8; i++) if (c.peekU8(at + i) !== SIGNATURE[i]) return false
  return true
}

/** Locate the superblock. The spec allows it at file offset 0 or after a user
 *  block sized 512·2^k; A1 forbids a non-zero user block, so a signature found at
 *  offset > 0 is a loud, named error rather than a silent accept. */
function findSuperblock(c: Cursor): number {
  if (matchSig(c, 0)) return 0
  for (let off = 512; off <= c.byteLength && off <= 1 << 24; off *= 2) {
    if (matchSig(c, off))
      throw new Hdf5Error(
        `non-zero user block: HDF5 signature found at 0x${off.toString(16)}, not 0 — ` +
          `user blocks are outside the INC-A subset`,
        off,
      )
  }
  throw new Hdf5Error('not an HDF5 file (signature 0x894844460d0a1a0a absent at offset 0)', 0)
}

export function parseSuperblock(c: Cursor): Superblock {
  const sbAddr = findSuperblock(c)
  c.seek(sbAddr + 8)
  const version = c.u8()

  if (version === 1)
    throw new Hdf5Error(
      `superblock version 1 (indexed-storage internal-node-K variant) is outside the ` +
        `INC-A subset — re-write with the default libver`,
      sbAddr + 8,
    )
  if (version === 3)
    throw new Hdf5Error(
      `superblock version 3: latest-format writer — re-write with the default libver ` +
        `(h5py libver='earliest' or the 1.8 default)`,
      sbAddr + 8,
    )
  if (version !== 0 && version !== 2)
    throw new Hdf5Error(
      `unsupported superblock version ${version} (INC-A reads v0 + v2)`,
      sbAddr + 8,
    )

  if (version === 0) {
    // v0: sizes at +13/+14, then the fixed prefix, then the root symbol-table entry.
    c.seek(sbAddr + 13)
    const offsetSize = c.u8()
    const lengthSize = c.u8()
    c.O = offsetSize
    c.L = lengthSize
    c.seek(sbAddr + 24) // skip reserved + group-K fields + consistency flags
    const baseAddress = c.offset()
    c.offset() // free-space info address (ignored)
    c.offset() // end-of-file address (ignored)
    c.offset() // driver information block address (ignored)
    // Root group symbol table entry: link-name-offset(O) + object-header-addr(O) + …
    c.offset() // link name offset (into the root's — nonexistent — parent heap)
    const rootObjectHeaderAddr = c.offset()
    return {
      version,
      offsetSize,
      lengthSize,
      baseAddress,
      rootObjectHeaderAddr,
      superblockAddr: sbAddr,
    }
  }

  // v2: sizes at +9/+10, then base/extension/eof/root addresses + checksum.
  c.seek(sbAddr + 9)
  const offsetSize = c.u8()
  const lengthSize = c.u8()
  c.u8() // file consistency flags (1 byte)
  c.O = offsetSize
  c.L = lengthSize
  const baseAddress = c.offset()
  const superblockExtensionAddr = c.offset()
  c.offset() // end-of-file address (ignored)
  const rootObjectHeaderAddr = c.offset()
  // A superblock extension can carry a shared-message table (A1: OUT). We do not
  // parse it; if one is present the object-header walk will hit a shared message
  // and fail loudly there. A defined extension address is noted but not fatal on
  // its own (the 1.8 link-format fixtures carry none).
  void superblockExtensionAddr
  return {
    version,
    offsetSize,
    lengthSize,
    baseAddress,
    rootObjectHeaderAddr,
    superblockAddr: sbAddr,
  }
}
