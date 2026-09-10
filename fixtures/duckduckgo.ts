/**
 * 录制下来的 DuckDuckGo 结果页夹具。
 *
 * 放在 tests/ 之外，是因为它同时被两处使用：
 *   · 测试 —— 不需要联网就能验证解析逻辑；
 *   · `scripts/run-example.ts --offline` —— 在无法访问 DuckDuckGo 的网络里
 *     也能完整跑一遍 pipeline，并生成 examples/ 下的示例产物。
 *
 * 内容结构照抄真实页面（含 uddg 跳转与广告位），因此解析代码走的是与线上同一条路径。
 */

/** 一份结果页：两条真实结果 + 一条站内广告（应被过滤）。 */
export const DUCKDUCKGO_FIXTURE = `<!DOCTYPE html>
<html><body>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&amp;rut=abc123">Alpha 官方文档</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&amp;rut=abc123">Alpha 是一个用于演示的示例项目，提供基础能力。</a>
  <div class="result__extras"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">example.com</a></div>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Beta 入门指南</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Beta 指南介绍了安装步骤与常见问题。</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">站内广告</a>
</div>
</body></html>`

/** 与上面结果对应的正文页。 */
export const DUCKDUCKGO_PAGES: Readonly<Record<string, string>> = {
  'https://example.com/alpha': '<html><head><title>Alpha 文档</title></head><body><p>Alpha 是一个用于演示的示例项目，它提供基础能力并保持接口稳定。安装 Alpha 只需要一条命令，随后即可开始使用。Alpha 的配置集中在单个文件里，便于迁移与备份。</p></body></html>',
  'https://example.com/beta': '<html><head><title>Beta 指南</title></head><body><p>Beta 的入门指南介绍了安装步骤与常见问题，适合第一次接触的用户阅读。指南同时给出了若干示例，帮助读者快速理解核心概念。</p></body></html>',
}
