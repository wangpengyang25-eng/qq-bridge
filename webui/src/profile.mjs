// 转发引用：真正的规则在仓库根的 src/profile.mjs
//
// bridge 和面板必须用同一份规则，否则"面板显示的亲密度"和"bridge 算出来的"
// 会随时间漂移。这里只做转发，不复制实现。
export * from '../../src/profile.mjs';
