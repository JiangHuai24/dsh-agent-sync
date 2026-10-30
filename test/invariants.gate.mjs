import assert from 'node:assert/strict'
import { assertNoMidSessionSystem, assertSeqConsecutive, countSurfaceEvents, SURFACE_TYPES } from '../index.js'

const sys = (seq) => ({ type: 'system/message', seq, time: 0, data: {}, surfaceOp: 'append' })
const user = (seq) => ({ type: 'user/message', seq, time: 0, data: {}, surfaceOp: 'append' })
const turnStart = (seq) => ({ type: 'turn/start', seq, time: 0, data: {} })

// 1. system/message 作为首个 surface event 是合法的
assert.doesNotThrow(() => assertNoMidSessionSystem(0, [sys(0), user(1)]))

// 2. 已有 surface 内容后再 append system/message → 拒绝
assert.throws(() => assertNoMidSessionSystem(3, [sys(10)]), /refusing to append system\/message mid-session/)

// 3. 同一批里先 user 后 system 也算 mid-session
assert.throws(() => assertNoMidSessionSystem(0, [user(0), sys(1)]), /mid-session/)

// 4. 只有非 surface 事件时不受影响
assert.doesNotThrow(() => assertNoMidSessionSystem(5, [turnStart(20)]))

// 5. seq 连续通过
assert.doesNotThrow(() => assertSeqConsecutive([turnStart(10), user(11), user(12)], 10))

// 6. seq 有洞 → 拒绝
assert.throws(() => assertSeqConsecutive([turnStart(10), user(12)], 10), /strictly consecutive/)

// 7. seq 起点不对 → 拒绝
assert.throws(() => assertSeqConsecutive([turnStart(11)], 10), /expected/)

// 8. 缺 seq → 拒绝
assert.throws(() => assertSeqConsecutive([{ type: 'user/message' }], 0), /without a numeric seq/)

// 9. surface 计数只算四类
assert.equal(countSurfaceEvents([turnStart(0), user(1), sys(2), { type: 'step/start', seq: 3 }]), 2)
assert.equal(SURFACE_TYPES.size, 4)

console.log('PASS  v4 invariants: mid-session system blocked, seq gaps blocked, non-surface unaffected')
